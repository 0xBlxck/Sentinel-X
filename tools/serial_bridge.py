"""Pont USB <-> MQTTS : lit les mesures de l'ESP8266 sur le port serie et les publie
sur le broker (TLS, CA du projet) ; renvoie a l'ESP les commandes recues sur
sentinel/cmd (buzzer, LED). Secours quand le Wi-Fi de table n'est pas disponible ;
les donnees suivent ensuite le meme chemin que celles de l'ESP.
Firmware a flasher : cd firmware && pio run -e bridge -t upload

Usage : uv run --with paho-mqtt --with pyserial python tools/serial_bridge.py --port COM3 --host 10.60.60.148
        (les identifiants sont lus dans .env : MQTT_ESP_USER / MQTT_ESP_PASSWORD)
"""
import argparse
import json
import re
import ssl
import threading
import time
from pathlib import Path

import paho.mqtt.client as mqtt
import serial

ROOT = Path(__file__).resolve().parent.parent
LINE = re.compile(r"\[capteurs\] T=(?P<t>-?[\d.]+)C H=(?P<h>[\d.]+)% gaz=(?P<g>\d+) mvt=(?P<m>[01])")

p = argparse.ArgumentParser()
p.add_argument("--port", default="COM9")
p.add_argument("--host", required=True, help="IP du serveur (celle du certificat TLS)")
p.add_argument("--mqtt-port", type=int, default=8883)
args = p.parse_args()

env = dict(l.strip().split("=", 1) for l in (ROOT / ".env").read_text().splitlines() if "=" in l and not l.startswith("#"))
client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
client.username_pw_set(env["MQTT_ESP_USER"], env["MQTT_ESP_PASSWORD"])
client.tls_set(ca_certs=str(ROOT / "server/mosquitto/certs/ca.crt"), tls_version=ssl.PROTOCOL_TLSv1_2)
ser = serial.Serial(args.port, 115200, timeout=1)
write_lock = threading.Lock()


def on_connect(client, userdata, flags, reason_code, properties):
    print(f"[mqtt] connecte ({reason_code})", flush=True)
    client.subscribe("sentinel/cmd", qos=1)


def on_message(client, userdata, msg):
    # commande du dashboard ou de la vision -> une ligne JSON vers l'ESP
    with write_lock:
        ser.write(msg.payload.strip() + b"\n")
    print(time.strftime("%H:%M:%S"), "[cmd] ->", msg.payload.decode(errors="replace"), flush=True)


client.on_connect, client.on_message = on_connect, on_message
client.connect(args.host, args.mqtt_port)
client.loop_start()

last_motion = False
with ser:
    print(f"pont actif : {args.port} <-> mqtts://{args.host}:{args.mqtt_port} (Ctrl+C pour arreter)")
    while True:
        line = ser.readline().decode("utf-8", "replace")
        if line.startswith("[cmd]"):
            print(time.strftime("%H:%M:%S"), "[esp]", line.strip(), flush=True)
        m = LINE.search(line)
        if not m:
            continue
        motion = m["m"] == "1"
        payload = {"temp": float(m["t"]), "hum": float(m["h"]), "gas": int(m["g"]),
                   "motion": int(motion), "motion_edge": int(motion and not last_motion)}
        last_motion = motion
        client.publish("sentinel/telemetry", json.dumps(payload), qos=0)
        print(time.strftime("%H:%M:%S"), payload, flush=True)
