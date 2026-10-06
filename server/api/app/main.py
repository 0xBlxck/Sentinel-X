import asyncio
import hmac
import json
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

import paho.mqtt.client as mqtt
from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from psycopg.types.json import Json
from psycopg_pool import ConnectionPool
from pydantic import BaseModel, Field

from .ml import AnomalyDetector

API_KEY = os.environ["API_KEY"]
TOPIC_TELEMETRY = "sentinel/telemetry"
TOPIC_CMD = "sentinel/cmd"
DASHBOARD_DIR = Path("/app/dashboard")

pool = ConnectionPool(os.environ["DATABASE_URL"], min_size=1, max_size=4, open=False)
detector = AnomalyDetector()
clients: set[WebSocket] = set()
ML_ALERT_COOLDOWN = 30.0  # secondes entre deux alertes d'anomalie
last_ml_alert = 0.0
mqtt_client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
loop: asyncio.AbstractEventLoop | None = None


def require_key(x_api_key: str = Header(default="")) -> None:
    if not hmac.compare_digest(x_api_key, API_KEY):
        raise HTTPException(status_code=401, detail="invalid api key")


async def broadcast(msg: dict) -> None:
    dead = []
    for ws in clients:
        try:
            await ws.send_json(msg)
        except Exception:
            dead.append(ws)
    for ws in dead:
        clients.discard(ws)


def store_alert(source: str, type_: str, severity: str, message: str | None, data: dict | None) -> dict:
    with pool.connection() as conn:
        row = conn.execute(
            "INSERT INTO alerts (source, type, severity, message, data) VALUES (%s,%s,%s,%s,%s) "
            "RETURNING id, ts",
            (source, type_, severity, message, Json(data or {})),
        ).fetchone()
    return {"id": row[0], "ts": row[1].isoformat(), "source": source, "type": type_,
            "severity": severity, "message": message, "data": data or {}}


def handle_telemetry(payload: dict) -> None:
    """Appele depuis le thread MQTT."""
    try:
        temp, hum, gas = float(payload["temp"]), float(payload["hum"]), int(payload["gas"])
        motion = bool(payload.get("motion", 0))
    except (KeyError, TypeError, ValueError):
        return  # payload invalide : ignore
    score, anomaly = detector.update(temp, hum, gas)
    with pool.connection() as conn:
        conn.execute(
            "INSERT INTO telemetry (temp, hum, gas, motion, anomaly_score, is_anomaly) "
            "VALUES (%s,%s,%s,%s,%s,%s)", (temp, hum, gas, motion, score, anomaly))
    events = [{"kind": "telemetry", "temp": temp, "hum": hum, "gas": gas, "motion": motion,
               "score": score, "anomaly": anomaly, "model_ready": detector.ready}]
    global last_ml_alert
    if anomaly and time.monotonic() - last_ml_alert >= ML_ALERT_COOLDOWN:
        last_ml_alert = time.monotonic()
        events.append({"kind": "alert", **store_alert(
            "ml", "anomaly", "high", "Anomalie detectee par Isolation Forest",
            {"temp": temp, "hum": hum, "gas": gas, "score": score})})
    if motion and payload.get("motion_edge"):
        events.append({"kind": "alert", **store_alert("esp8266", "motion", "medium", "Mouvement PIR", {})})
    for ev in events:
        asyncio.run_coroutine_threadsafe(broadcast(ev), loop)


def on_connect(client, userdata, flags, reason_code, properties):
    client.subscribe(TOPIC_TELEMETRY)


def on_message(client, userdata, msg):
    try:
        handle_telemetry(json.loads(msg.payload))
    except Exception as exc:  # ne jamais tuer le thread MQTT
        print("telemetry error:", exc, flush=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global loop
    loop = asyncio.get_running_loop()
    pool.open()
    mqtt_client.username_pw_set(os.environ["MQTT_USER"], os.environ["MQTT_PASSWORD"])
    mqtt_client.on_connect, mqtt_client.on_message = on_connect, on_message
    mqtt_client.connect_async(os.environ["MQTT_HOST"], int(os.environ["MQTT_PORT"]))
    mqtt_client.loop_start()
    yield
    mqtt_client.loop_stop()
    pool.close()


app = FastAPI(title="Sentinel-X API", lifespan=lifespan)


class AlertIn(BaseModel):
    source: str = Field(max_length=32)
    type: str = Field(max_length=32)
    severity: Literal["info", "medium", "high", "critical"] = "info"
    message: str | None = Field(default=None, max_length=256)
    data: dict | None = None


class CommandIn(BaseModel):
    buzzer: bool | None = None
    led: Literal["green", "red", "off"] | None = None


@app.post("/api/v1/alerts", status_code=201, dependencies=[Depends(require_key)])
async def post_alert(alert: AlertIn):
    row = await asyncio.to_thread(
        store_alert, alert.source, alert.type, alert.severity, alert.message, alert.data)
    await broadcast({"kind": "alert", **row})
    return row


@app.get("/api/v1/alerts", dependencies=[Depends(require_key)])
def list_alerts(limit: int = 50):
    with pool.connection() as conn:
        rows = conn.execute(
            "SELECT id, ts, source, type, severity, message FROM alerts ORDER BY ts DESC LIMIT %s",
            (min(limit, 500),)).fetchall()
    return [{"id": r[0], "ts": r[1].isoformat(), "source": r[2], "type": r[3],
             "severity": r[4], "message": r[5]} for r in rows]


@app.get("/api/v1/telemetry", dependencies=[Depends(require_key)])
def list_telemetry(limit: int = 200):
    with pool.connection() as conn:
        rows = conn.execute(
            "SELECT ts, temp, hum, gas, motion, is_anomaly FROM telemetry ORDER BY ts DESC LIMIT %s",
            (min(limit, 2000),)).fetchall()
    return [{"ts": r[0].isoformat(), "temp": r[1], "hum": r[2], "gas": r[3],
             "motion": r[4], "anomaly": r[5]} for r in reversed(rows)]


@app.post("/api/v1/command", dependencies=[Depends(require_key)])
async def post_command(cmd: CommandIn):
    payload = cmd.model_dump(exclude_none=True)
    mqtt_client.publish(TOPIC_CMD, json.dumps(payload), qos=1)
    # tous les dashboards voient l'etat des actionneurs, meme si la commande vient de la vision
    await broadcast({"kind": "command", **payload})
    return {"sent": payload}


@app.get("/api/v1/health")
def health():
    return {"status": "ok", "model_ready": detector.ready, "mqtt": mqtt_client.is_connected()}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket, key: str = ""):
    if not hmac.compare_digest(key, API_KEY):
        await ws.close(code=4401)
        return
    await ws.accept()
    clients.add(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(ws)


@app.get("/")
def index():
    return FileResponse(DASHBOARD_DIR / "index.html")


app.mount("/static", StaticFiles(directory=DASHBOARD_DIR), name="static")
