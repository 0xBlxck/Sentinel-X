"""Simulateur de boitier : publie des mesures realistes sur le broker (MQTTS, comptes ESP)
pour developper et repeter la demo sans ESP8266. Les donnees suivent le vrai chemin :
Mosquitto -> API -> Isolation Forest -> WebSocket -> dashboard.

Scenarios :
  normal     mesures stables (bruit capteur)
  chauffe    montee lente de temperature + derive du gaz (maintenance predictive)
  fuite      pic de gaz / fumee sur le MQ-2
  intrusion  mouvement PIR + alerte vision (POST /api/v1/alerts)
  demo       apprentissage accelere puis enchainement des scenarios en boucle

Usage : uv run --with paho-mqtt python tools/simulate.py --host 10.60.60.148 --scenario demo
        (identifiants lus dans .env : MQTT_ESP_USER / MQTT_ESP_PASSWORD / API_KEY)
"""
import argparse
import json
import random
import ssl
import time
import urllib.request
from pathlib import Path

import paho.mqtt.client as mqtt

ROOT = Path(__file__).resolve().parent.parent
SCENARIOS = ("normal", "chauffe", "fuite", "intrusion", "demo")

p = argparse.ArgumentParser()
p.add_argument("--host", required=True, help="IP du serveur (celle du certificat TLS)")
p.add_argument("--mqtt-port", type=int, default=8883)
p.add_argument("--api", default="http://localhost:8000")
p.add_argument("--scenario", choices=SCENARIOS, default="demo")
p.add_argument("--interval", type=float, default=2.0, help="secondes entre deux mesures (ESP : 2 s)")
args = p.parse_args()

env = dict(l.strip().split("=", 1) for l in (ROOT / ".env").read_text().splitlines() if "=" in l and not l.startswith("#"))
client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
client.username_pw_set(env["MQTT_ESP_USER"], env["MQTT_ESP_PASSWORD"])
client.tls_set(ca_certs=str(ROOT / "server/mosquitto/certs/ca.crt"), tls_version=ssl.PROTOCOL_TLSv1_2)
client.connect(args.host, args.mqtt_port)
client.loop_start()


class Box:
    """Etat physique simule du boitier."""

    def __init__(self) -> None:
        self.temp, self.hum, self.gas = 24.0, 52.0, 140.0
        self.motion = False

    def relax(self, k: float = 0.15) -> None:
        """Retour progressif vers le regime nominal."""
        self.temp += (24.0 - self.temp) * k
        self.hum += (52.0 - self.hum) * k
        self.gas += (140.0 - self.gas) * k

    def publish(self, motion_edge: bool = False) -> None:
        payload = {
            "temp": round(self.temp + random.gauss(0, 0.08), 1),
            "hum": round(self.hum + random.gauss(0, 0.3), 1),
            "gas": max(0, int(self.gas + random.gauss(0, 3))),
            "motion": int(self.motion),
            "motion_edge": int(motion_edge),
        }
        client.publish("sentinel/telemetry", json.dumps(payload), qos=0)
        print(time.strftime("%H:%M:%S"), payload, flush=True)


def post_vision_alert() -> None:
    count = random.choice([1, 1, 2])
    body = json.dumps({
        "source": "vision", "type": "intrusion", "severity": "high",
        "message": f"{count} personne(s) detectee(s)",
        "data": {"count": count, "confidence": round(random.uniform(0.72, 0.94), 2),
                 "inference_ms": round(random.uniform(55, 70), 1)},
    }).encode()
    req = urllib.request.Request(f"{args.api}/api/v1/alerts", data=body, method="POST",
                                 headers={"Content-Type": "application/json", "X-API-Key": env["API_KEY"]})
    try:
        urllib.request.urlopen(req, timeout=3)
        print("  -> alerte vision envoyee", flush=True)
    except OSError as exc:
        print("  -> alerte vision refusee :", exc, flush=True)


box = Box()


def run(name: str, steps: int, interval: float) -> None:
    print(f"== {name} ({steps} mesures)", flush=True)
    for i in range(steps):
        edge = False
        if name == "normal":
            box.motion = False
            box.relax()
        elif name == "chauffe":
            box.temp += 0.35 + random.uniform(0, 0.1)
            box.hum -= 0.4
            box.gas += 6
        elif name == "fuite":
            box.gas = min(1023.0, box.gas + (180 if i < 4 else -40))
        elif name == "intrusion":
            edge = i == 0 and not box.motion
            box.motion = i < steps - 2
            if i == 1:
                post_vision_alert()
        box.publish(edge)
        time.sleep(interval)


try:
    if args.scenario != "demo":
        while True:
            run(args.scenario, 10, args.interval)
    run("apprentissage", 0, 0)
    for _ in range(65):  # MIN_TRAIN = 60 cote API : apprentissage accelere
        box.relax()
        box.publish()
        time.sleep(0.25)
    while True:
        run("normal", 15, args.interval)
        run("chauffe", 8, args.interval)
        run("normal", 15, args.interval)
        run("intrusion", 5, args.interval)
        run("normal", 15, args.interval)
        run("fuite", 6, args.interval)
except KeyboardInterrupt:
    pass
finally:
    client.loop_stop()
