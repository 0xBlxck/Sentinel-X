"""Detection de presence humaine (YOLOv8-tiny) et controle d'acces par reconnaissance
faciale, sur la webcam USB du PC serveur.

Pipeline en 3 etages pour un flux fluide et sans retard :
- capture   : lit la camera en continu, ne garde que la derniere image (pas de file
              d'attente qui accumule du retard), se reconnecte si la camera decroche
- inference : YOLO sur l'image la plus recente (640x480, < 100 ms/trame vise), puis
              identification des visages (faces.py) quand une personne est presente
- flux      : MJPEG a la cadence de la camera sur http://<host>:8090/stream, avec les
              dernieres detections dessinees ; etat JSON sur /status

Alertes (POST /api/v1/alerts), toutes confirmees dans le temps (pas sur une seule image) :
- visage inconnu   -> critical + buzzer et LED rouge sur l'ESP (POST /api/v1/command),
                      coupes automatiquement --alarm-hold s apres le depart de l'inconnu
- visage autorise  -> info "acces autorise" (une fois par minute et par personne)
- personne sans visage identifiable et aucun visage autorise vu recemment -> high
"""
import argparse
import hmac
import json
import logging
import os
import threading
import time
import urllib.request
from collections import deque

import cv2
import numpy as np
from flask import Flask, Response, jsonify, request
from ultralytics import YOLO

p = argparse.ArgumentParser()
p.add_argument("--camera", type=int, default=0)
p.add_argument("--list", action="store_true", help="liste les cameras disponibles et quitte")
p.add_argument("--api", default="http://localhost:8000")
p.add_argument("--port", type=int, default=8090)
p.add_argument("--conf", type=float, default=0.5)
p.add_argument("--confirm", type=float, default=1.0, help="secondes de presence confirmee avant alerte")
p.add_argument("--cooldown", type=float, default=10.0, help="secondes entre deux alertes")
p.add_argument("--no-faces", action="store_true", help="desactive la reconnaissance faciale")
p.add_argument("--face-threshold", type=float, default=0.363, help="similarite minimale pour reconnaitre")
p.add_argument("--unknown-confirm", type=float, default=2.0, help="secondes de visage inconnu avant alarme")
p.add_argument("--alarm-hold", type=float, default=10.0, help="secondes sans inconnu avant de couper le buzzer")
p.add_argument("--no-buzzer", action="store_true", help="ne pas declencher le buzzer de l'ESP")
args = p.parse_args()

W, H = 640, 480
BACKENDS = [("DSHOW", cv2.CAP_DSHOW), ("MSMF", cv2.CAP_MSMF)] if os.name == "nt" else [("ANY", cv2.CAP_ANY)]
CYAN, RED, GREEN, GREY = (255, 230, 62), (92, 59, 255), (154, 245, 43), (150, 150, 150)  # BGR
KNOWN_GRACE = 30.0     # s : une personne autorisee vue recemment couvre les silhouettes sans visage
ACCESS_COOLDOWN = 60.0  # s entre deux alertes "acces autorise" pour la meme personne


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
book = None
if not args.no_faces:
    from faces import FaceBook, valid_name
    book = FaceBook(threshold=args.face_threshold)


class Shared:
    """Etat partage entre les 3 etages."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.new_frame = threading.Condition(self.lock)
        self.raw: np.ndarray | None = None   # derniere image brute
        self.raw_id = 0
        self.jpeg = b""                       # derniere image annotee encodee
        self.jpeg_id = 0
        self.boxes: list[tuple] = []          # personnes (x1, y1, x2, y2, conf)
        self.faces: list[dict] = []           # visages identifies (faces.FaceBook.identify)
        self.camera_ok = False
        self.cam_fps = 0.0
        self.infer_ms = 0.0
        self.infer_fps = 0.0
        self.persons = 0


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
            boxes, faces = list(S.boxes), list(S.faces)
        publish(annotate(frame, boxes, faces))


# ---------- etage 2 : inference et decisions ----------
def api_post(path: str, payload: dict) -> bool:
    req = urllib.request.Request(f"{args.api}{path}", data=json.dumps(payload).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "X-API-Key": API_KEY})
    try:
        urllib.request.urlopen(req, timeout=3).read()
        return True
    except Exception as exc:
        log(f"[api] echec {path} : {exc}")
        return False


def alert(type_: str, severity: str, message: str, data: dict) -> None:
    def send():
        if api_post("/api/v1/alerts", {"source": "vision", "type": type_, "severity": severity,
                                       "message": message, "data": data}):
            log(f"[alerte] {severity} {type_} : {message}")
        if type_ == "unknown_face" and not args.no_buzzer:
            api_post("/api/v1/command", {"buzzer": True, "led": "red"})
        elif type_ == "access" and not args.no_buzzer:
            api_post("/api/v1/command", {"chime": "access"})
    threading.Thread(target=send, daemon=True).start()


class Window:
    """Proportion d'inferences ou une condition est vraie sur les N dernieres secondes."""

    def __init__(self, seconds: float) -> None:
        self.seconds, self.items = seconds, deque()

    def add(self, now: float, value: bool) -> bool:
        self.items.append((now, value))
        while self.items and now - self.items[0][0] > self.seconds:
            self.items.popleft()
        return len(self.items) >= 3 and sum(v for _, v in self.items) >= 0.6 * len(self.items)


def inference_loop() -> None:
    seen_id = 0
    presence, unknown = Window(args.confirm), Window(args.unknown_confirm)
    times: deque = deque(maxlen=10)
    last = {"intrusion": 0.0, "unknown": 0.0}
    last_access: dict[str, float] = {}
    known_seen = last_stranger = 0.0
    alarm_on = False
    while True:
        with S.lock:
            frame, fid = S.raw, S.raw_id
        if frame is None or fid == seen_id:
            time.sleep(0.005)
            continue
        seen_id = fid
        t0 = time.perf_counter()
        res = model.predict(frame, classes=[0], conf=args.conf, imgsz=W, verbose=False)[0]
        boxes = [(*map(int, b[:4]), float(b[4])) for b in res.boxes.data.tolist()]
        faces = book.identify(frame) if book and boxes else []
        ms = (time.perf_counter() - t0) * 1000
        times.append(time.perf_counter())
        with S.lock:
            S.boxes, S.faces = boxes, faces
            S.persons = len(boxes)
            S.infer_ms = ms
            if len(times) > 1:
                S.infer_fps = (len(times) - 1) / (times[-1] - times[0])

        now = time.monotonic()
        judged = [f for f in faces if not f["small"]]
        # base vide : personne n'est "inconnu", on retombe sur l'alerte de presence classique
        strangers = [f for f in judged if f["name"] is None] if book and book.people else []
        for f in judged:
            if f["name"]:
                known_seen = now
                if now - last_access.get(f["name"], -ACCESS_COOLDOWN) >= ACCESS_COOLDOWN:
                    last_access[f["name"]] = now
                    alert("access", "info", f"Acces autorise : {f['name']}",
                          {"name": f["name"], "similarity": f["score"]})

        if strangers:
            last_stranger = now
        if unknown.add(now, bool(strangers)) and strangers and now - last["unknown"] > args.cooldown:
            last["unknown"] = now
            alarm_on = not args.no_buzzer
            alert("unknown_face", "critical", f"{len(strangers)} visage(s) inconnu(s)",
                  {"count": len(strangers), "similarity": max(f["score"] for f in strangers),
                   "inference_ms": round(ms, 1)})
        # l'alarme declenchee par la vision s'arrete seule quand l'inconnu est parti
        if alarm_on and now - last_stranger > args.alarm_hold:
            alarm_on = False
            log(f"[alarme] aucun inconnu depuis {args.alarm_hold:.0f} s : buzzer coupe")
            threading.Thread(target=api_post, args=("/api/v1/command", {"buzzer": False, "led": "green"}),
                             daemon=True).start()

        # silhouette sans visage exploitable : alerte seulement si personne d'autorise n'est la
        covered = book is not None and now - known_seen < KNOWN_GRACE
        if (presence.add(now, bool(boxes)) and boxes and not strangers and not covered
                and now - last["intrusion"] > args.cooldown):
            last["intrusion"] = now
            alert("intrusion", "high", f"{len(boxes)} personne(s) detectee(s)"
                  + (", visage non identifie" if book else ""),
                  {"count": len(boxes), "confidence": round(max(b[4] for b in boxes), 2),
                   "inference_ms": round(ms, 1)})


# ---------- etage 3 : rendu et flux ----------
def label(img: np.ndarray, text: str, x: int, y: int, color: tuple) -> None:
    (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
    y = max(y, th + 8)
    cv2.rectangle(img, (x, y - th - 8), (x + tw + 8, y), color, -1)
    cv2.putText(img, text, (x + 4, y - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)


def annotate(frame: np.ndarray, boxes: list[tuple], faces: list[dict]) -> np.ndarray:
    out = frame.copy()
    known_centers = [(f["box"][0] + f["box"][2] // 2, f["box"][1] + f["box"][3] // 2) for f in faces if f["name"]]
    for x1, y1, x2, y2, conf in boxes:
        ok = any(x1 <= cx <= x2 and y1 <= cy <= y2 for cx, cy in known_centers)
        color = GREEN if ok else RED
        cv2.rectangle(out, (x1, y1), (x2, y2), color, 1 if faces else 2)
        if not faces:
            label(out, f"PERSONNE {conf * 100:.0f}%", x1, y1, color)
    for f in faces:
        x, y, w, h = f["box"]
        if f["small"]:
            color, text = GREY, "TROP LOIN"
        elif f["name"]:
            color, text = GREEN, f"{f['name'].upper()} {f['score'] * 100:.0f}%"
        else:
            color, text = RED, "INCONNU"
        cv2.rectangle(out, (x, y), (x + w, y + h), color, 2)
        label(out, text, x, y, color)
    status = f"YOLOv8n {S.infer_ms:.0f} ms | {S.cam_fps:.0f} fps | personnes: {len(boxes)}"
    alarm = any(not f["small"] and not f["name"] for f in faces) or (boxes and not faces and book is None)
    cv2.putText(out, status, (12, H - 14), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 3, cv2.LINE_AA)
    cv2.putText(out, status, (12, H - 14), cv2.FONT_HERSHEY_SIMPLEX, 0.5, RED if alarm else GREEN, 1, cv2.LINE_AA)
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
    # lu par le dashboard (port 8000) ; la cle passe par un en-tete, pas par un cookie
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, X-API-Key"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
    return resp


def authorized() -> bool:
    return bool(API_KEY) and hmac.compare_digest(request.headers.get("X-API-Key", ""), API_KEY)


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
                       infer_fps=round(S.infer_fps, 1), persons=S.persons, face_recognition=book is not None,
                       faces=[{"name": f["name"], "score": f["score"], "small": f["small"]} for f in S.faces])


@app.route("/faces", methods=["GET"])
def faces_list():
    if not authorized():
        return jsonify(error="cle invalide"), 401
    return jsonify(book.names() if book else [])


@app.route("/faces", methods=["POST"])
def faces_enroll():
    if not authorized():
        return jsonify(error="cle invalide"), 401
    if not book:
        return jsonify(error="reconnaissance faciale desactivee"), 409
    name = str((request.get_json(silent=True) or {}).get("name", "")).strip()
    if not valid_name(name):
        return jsonify(error="nom invalide (lettres, chiffres, espace, - et _ ; 32 max)"), 422
    frames, last_id = [], 0
    for _ in range(12):  # ~3 s : bouger legerement la tete pour varier les angles
        time.sleep(0.25)
        with S.lock:
            if S.raw is not None and S.raw_id != last_id:
                frames.append(S.raw.copy())
                last_id = S.raw_id
    count = book.enroll(name, frames)
    if not count:
        return jsonify(error="aucun visage net : se placer face a la camera, plus pres"), 422
    log(f"[visages] {name} enregistre ({count} echantillons)")
    return jsonify(name=name, samples=count)


@app.route("/faces/<name>", methods=["DELETE"])
def faces_delete(name: str):
    if not authorized():
        return jsonify(error="cle invalide"), 401
    if not book or not valid_name(name) or not book.delete(name):
        return jsonify(error="inconnu"), 404
    log(f"[visages] {name} supprime")
    return jsonify(deleted=name)


if __name__ == "__main__":
    model.predict(np.zeros((H, W, 3), np.uint8), verbose=False)  # chauffe : la 1re inference est lente
    threading.Thread(target=capture_loop, daemon=True).start()
    threading.Thread(target=inference_loop, daemon=True).start()
    log(f"flux : http://localhost:{args.port}/stream  etat : http://localhost:{args.port}/status")
    app.run(host="0.0.0.0", port=args.port, threaded=True)
