"""Detection de presence humaine (YOLOv8-tiny) sur la webcam USB du PC serveur.

Pipeline en 3 etages pour un flux fluide et sans retard :
- capture   : lit la camera en continu, ne garde que la derniere image (pas de file
              d'attente qui accumule du retard), se reconnecte si la camera decroche
- inference : YOLO sur l'image la plus recente (640x480, < 100 ms/trame vise)
- flux      : MJPEG a la cadence de la camera sur http://<host>:8090/stream, avec les
              dernieres detections dessinees ; etat JSON sur /status

Une alerte (POST /api/v1/alerts) n'est envoyee que si la presence est confirmee sur
--confirm secondes (60 % des inferences), ce qui evite les faux positifs d'une seule image.
"""
import argparse
import json
import logging
import os
import threading
import time
import urllib.request
from collections import deque

import cv2
import numpy as np
from flask import Flask, Response, jsonify
from ultralytics import YOLO

p = argparse.ArgumentParser()
p.add_argument("--camera", type=int, default=0)
p.add_argument("--list", action="store_true", help="liste les cameras disponibles et quitte")
p.add_argument("--api", default="http://localhost:8000")
p.add_argument("--port", type=int, default=8090)
p.add_argument("--conf", type=float, default=0.5)
p.add_argument("--confirm", type=float, default=1.0, help="secondes de presence confirmee avant alerte")
p.add_argument("--cooldown", type=float, default=10.0, help="secondes entre deux alertes")
args = p.parse_args()

W, H = 640, 480
BACKENDS = [("DSHOW", cv2.CAP_DSHOW), ("MSMF", cv2.CAP_MSMF)] if os.name == "nt" else [("ANY", cv2.CAP_ANY)]
CYAN, RED, GREEN = (255, 230, 62), (92, 59, 255), (154, 245, 43)  # BGR, couleurs du dashboard


def log(msg: str) -> None:
    print(time.strftime("%H:%M:%S"), msg, flush=True)


if args.list:
    for i in range(6):
        for name, be in BACKENDS:
            cap = cv2.VideoCapture(i, be)
            if cap.isOpened() and cap.read()[0]:
                print(f"camera {i} : OK ({name}, {int(cap.get(3))}x{int(cap.get(4))})")
                cap.release()
                break
            cap.release()
    raise SystemExit

API_KEY = os.environ.get("API_KEY", "")
model = YOLO("yolov8n.pt")  # telecharge automatiquement au 1er lancement


class Shared:
    """Etat partage entre les 3 etages."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.new_frame = threading.Condition(self.lock)
        self.raw: np.ndarray | None = None   # derniere image brute
        self.raw_id = 0
        self.jpeg = b""                       # derniere image annotee encodee
        self.jpeg_id = 0
        self.boxes: list[tuple] = []          # (x1, y1, x2, y2, conf)
        self.camera_ok = False
        self.cam_fps = 0.0
        self.infer_ms = 0.0
        self.infer_fps = 0.0
        self.persons = 0
        self.last_alert = 0.0


S = Shared()


# ---------- etage 1 : capture ----------
def open_camera(index: int) -> cv2.VideoCapture | None:
    for name, be in BACKENDS:
        cap = cv2.VideoCapture(index, be)
        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, W)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, H)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        if cap.isOpened() and cap.read()[0]:
            log(f"[camera] index {index} ouverte ({name})")
            return cap
        cap.release()
    return None


def capture_loop() -> None:
    cap, backoff = None, 1.0
    times: deque = deque(maxlen=30)
    while True:
        if cap is None:
            cap = open_camera(args.camera)
            if cap is None:
                if S.camera_ok or backoff == 1.0:
                    log(f"[camera] index {args.camera} indisponible : verifier le cable, fermer les applis "
                        "qui utilisent la webcam, ou essayer --list")
                S.camera_ok = False
                publish(placeholder("CAMERA DECONNECTEE", "reconnexion automatique..."))
                time.sleep(backoff)
                backoff = min(backoff * 2, 8.0)
                continue
            backoff = 1.0
        ok, frame = cap.read()
        if not ok:
            log("[camera] perte du flux, reconnexion")
            cap.release()
            cap, S.camera_ok = None, False
            continue
        if frame.shape[1] != W or frame.shape[0] != H:
            frame = cv2.resize(frame, (W, H))
        times.append(time.perf_counter())
        with S.lock:
            S.raw = frame
            S.raw_id += 1
            S.camera_ok = True
            if len(times) > 1:
                S.cam_fps = (len(times) - 1) / (times[-1] - times[0])
            boxes = list(S.boxes)
        publish(annotate(frame, boxes))


# ---------- etage 2 : inference ----------
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
        log(f"[alerte] intrusion envoyee ({count} personne(s), {conf:.2f})")
    except Exception as exc:
        log(f"[alerte] echec de l'envoi : {exc}")


def inference_loop() -> None:
    seen_id = 0
    recent: deque = deque()  # (instant, presence) sur la fenetre de confirmation
    times: deque = deque(maxlen=10)
    while True:
        with S.lock:
            frame, fid = S.raw, S.raw_id
        if frame is None or fid == seen_id:
            time.sleep(0.005)
            continue
        seen_id = fid
        t0 = time.perf_counter()
        res = model.predict(frame, classes=[0], conf=args.conf, imgsz=W, verbose=False)[0]
        ms = (time.perf_counter() - t0) * 1000
        boxes = [(*map(int, b[:4]), float(b[4])) for b in res.boxes.data.tolist()]
        times.append(time.perf_counter())
        now = time.monotonic()
        recent.append((now, bool(boxes)))
        while recent and now - recent[0][0] > args.confirm:
            recent.popleft()
        confirmed = len(recent) >= 3 and sum(v for _, v in recent) >= 0.6 * len(recent)
        with S.lock:
            S.boxes = boxes
            S.persons = len(boxes)
            S.infer_ms = ms
            if len(times) > 1:
                S.infer_fps = (len(times) - 1) / (times[-1] - times[0])
        if confirmed and boxes and time.time() - S.last_alert > args.cooldown:
            S.last_alert = time.time()
            threading.Thread(target=post_alert, args=(len(boxes), max(b[4] for b in boxes), ms), daemon=True).start()


# ---------- etage 3 : rendu et flux ----------
def annotate(frame: np.ndarray, boxes: list[tuple]) -> np.ndarray:
    out = frame.copy()
    for x1, y1, x2, y2, conf in boxes:
        cv2.rectangle(out, (x1, y1), (x2, y2), RED, 2)
        label = f"PERSONNE {conf * 100:.0f}%"
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
        cv2.rectangle(out, (x1, y1 - th - 8), (x1 + tw + 8, y1), RED, -1)
        cv2.putText(out, label, (x1 + 4, y1 - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
    status = f"YOLOv8n {S.infer_ms:.0f} ms | {S.cam_fps:.0f} fps | personnes: {len(boxes)}"
    cv2.putText(out, status, (12, H - 14), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 3, cv2.LINE_AA)
    cv2.putText(out, status, (12, H - 14), cv2.FONT_HERSHEY_SIMPLEX, 0.5, RED if boxes else GREEN, 1, cv2.LINE_AA)
    return out


def placeholder(title: str, sub: str) -> np.ndarray:
    img = np.zeros((H, W, 3), np.uint8)
    img[::4] = 18  # lignes de balayage
    for text, y, scale, color in ((title, H // 2 - 6, 0.9, (255, 255, 255)), (sub, H // 2 + 26, 0.55, CYAN)):
        (tw, _), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, scale, 2)
        cv2.putText(img, text, ((W - tw) // 2, y), cv2.FONT_HERSHEY_SIMPLEX, scale, color, 2, cv2.LINE_AA)
    return img


def publish(img: np.ndarray) -> None:
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 75])
    if ok:
        with S.new_frame:
            S.jpeg = buf.tobytes()
            S.jpeg_id += 1
            S.new_frame.notify_all()


app = Flask(__name__)
logging.getLogger("werkzeug").setLevel(logging.WARNING)  # pas une ligne par requete /status


@app.after_request
def headers(resp):
    resp.headers["Cache-Control"] = "no-store"
    resp.headers["Access-Control-Allow-Origin"] = "*"  # /status lu par le dashboard (port 8000)
    return resp


def mjpeg():
    last = 0
    while True:
        with S.new_frame:
            S.new_frame.wait_for(lambda: S.jpeg_id != last, timeout=2.0)
            frame, last = S.jpeg, S.jpeg_id
        if frame:
            yield b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(frame)).encode() + b"\r\n\r\n" + frame + b"\r\n"


@app.route("/stream")
def stream():
    return Response(mjpeg(), mimetype="multipart/x-mixed-replace; boundary=frame")


@app.route("/status")
def status():
    with S.lock:
        return jsonify(camera=S.camera_ok, cam_fps=round(S.cam_fps, 1), infer_ms=round(S.infer_ms, 1),
                       infer_fps=round(S.infer_fps, 1), persons=S.persons)


if __name__ == "__main__":
    model.predict(np.zeros((H, W, 3), np.uint8), verbose=False)  # chauffe : la 1re inference est lente
    threading.Thread(target=capture_loop, daemon=True).start()
    threading.Thread(target=inference_loop, daemon=True).start()
    log(f"flux : http://localhost:{args.port}/stream  etat : http://localhost:{args.port}/status")
    app.run(host="0.0.0.0", port=args.port, threaded=True)
