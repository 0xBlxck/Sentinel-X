"""Detection de presence humaine (YOLOv8-tiny) sur la webcam USB du PC serveur.

- redimensionne chaque image en 640x480 (< 100 ms/trame visé)
- expose le flux annote en MJPEG sur http://<host>:8081/stream (affiche par le dashboard)
- poste une alerte sur POST /api/v1/alerts quand une personne est detectee
"""
import argparse
import json
import os
import threading
import time
import urllib.request

import cv2
from flask import Flask, Response
from ultralytics import YOLO

p = argparse.ArgumentParser()
p.add_argument("--camera", type=int, default=0)
p.add_argument("--api", default="http://localhost:8000")
p.add_argument("--port", type=int, default=8081)
p.add_argument("--conf", type=float, default=0.5)
p.add_argument("--cooldown", type=float, default=10.0, help="secondes entre deux alertes")
args = p.parse_args()

API_KEY = os.environ.get("API_KEY", "")
model = YOLO("yolov8n.pt")  # telecharge automatiquement au 1er lancement
latest_jpeg: bytes = b""
lock = threading.Lock()


def post_alert(count: int, conf: float, ms: float) -> None:
    body = json.dumps({
        "source": "vision", "type": "intrusion", "severity": "high",
        "message": f"{count} personne(s) detectee(s)",
        "data": {"count": count, "confidence": round(conf, 2), "inference_ms": round(ms, 1)},
    }).encode()
    req = urllib.request.Request(f"{args.api}/api/v1/alerts", data=body, method="POST",
                                 headers={"Content-Type": "application/json", "X-API-Key": API_KEY})
    try:
        urllib.request.urlopen(req, timeout=3).read()
    except Exception as exc:
        print("alert post failed:", exc, flush=True)


def open_camera(index: int) -> "cv2.VideoCapture":
    """Ouvre la camera en essayant plusieurs moteurs Windows (DirectShow puis MSMF)."""
    backends = [("DSHOW", cv2.CAP_DSHOW), ("MSMF", cv2.CAP_MSMF)] if os.name == "nt" else [("ANY", cv2.CAP_ANY)]
    for name, be in backends:
        cap = cv2.VideoCapture(index, be)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        if cap.isOpened() and cap.read()[0]:
            print(f"[camera] index {index} ouverte ({name})", flush=True)
            return cap
        print(f"[camera] index {index} : echec avec {name}", flush=True)
        cap.release()
    return cv2.VideoCapture(index)  # derniere chance, la boucle signalera l'absence d'image


def capture_loop() -> None:
    global latest_jpeg
    cap = open_camera(args.camera)
    last_alert = 0.0
    fails = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            fails += 1
            if fails % 10 == 1:
                print(f"[camera] pas d'image (index {args.camera}) : essayez --camera 0/1/2, "
                      "fermez les applis qui utilisent la webcam", flush=True)
            time.sleep(0.5)
            continue
        fails = 0
        frame = cv2.resize(frame, (640, 480))
        t0 = time.perf_counter()
        res = model.predict(frame, classes=[0], conf=args.conf, imgsz=640, verbose=False)[0]
        ms = (time.perf_counter() - t0) * 1000
        n = len(res.boxes)
        annotated = res.plot()
        cv2.putText(annotated, f"{ms:.0f} ms | personnes: {n}", (10, 24),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0) if n == 0 else (0, 0, 255), 2)
        if n and time.time() - last_alert > args.cooldown:
            last_alert = time.time()
            threading.Thread(target=post_alert, args=(n, float(res.boxes.conf.max()), ms), daemon=True).start()
        ok, buf = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 70])
        if ok:
            with lock:
                latest_jpeg = buf.tobytes()


app = Flask(__name__)


@app.after_request
def no_cache(resp):
    resp.headers["Cache-Control"] = "no-store"
    return resp


def mjpeg():
    while True:
        with lock:
            frame = latest_jpeg
        if frame:
            yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + frame + b"\r\n"
        time.sleep(0.05)


@app.route("/stream")
def stream():
    return Response(mjpeg(), mimetype="multipart/x-mixed-replace; boundary=frame")


if __name__ == "__main__":
    threading.Thread(target=capture_loop, daemon=True).start()
    app.run(host="0.0.0.0", port=args.port, threaded=True)
