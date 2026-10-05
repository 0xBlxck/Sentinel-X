"""Pont USB -> MQTTS : lit les mesures de l'ESP8266 sur le port serie et les publie
sur le broker (TLS, CA du projet). Secours de developpement quand le Wi-Fi de table
n'est pas disponible ; les donnees suivent ensuite le meme chemin que celles de l'ESP.

Usage : python tools/serial_bridge.py --port COM9 --host 10.14.44.50
        (les identifiants sont lus dans .env : MQTT_ESP_USER / MQTT_ESP_PASSWORD)
"""
import argparse
import json
import re
import ssl
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
client.connect(args.host, args.mqtt_port)
client.loop_start()

last_motion = False
with serial.Serial(args.port, 115200, timeout=1) as ser:
    print(f"pont actif : {args.port} -> mqtts://{args.host}:{args.mqtt_port} (Ctrl+C pour arreter)")
    while True:
        m = LINE.search(ser.readline().decode("utf-8", "replace"))
        if not m:
            continue
        motion = m["m"] == "1"
        payload = {"temp": float(m["t"]), "hum": float(m["h"]), "gas": int(m["g"]),
                   "motion": int(motion), "motion_edge": int(motion and not last_motion)}
        last_motion = motion
        client.publish("sentinel/telemetry", json.dumps(payload), qos=0)
        print(time.strftime("%H:%M:%S"), payload, flush=True)
