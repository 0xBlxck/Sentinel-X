"""Detection de presence humaine (YOLOv8-tiny) et controle d'acces par reconnaissance
faciale, sur la webcam USB du PC serveur.

Pipeline en 3 etages pour un flux fluide et sans retard :
- capture   : lit la camera en continu, ne garde que la derniere image (pas de file
              d'attente qui accumule du retard), se reconnecte si la camera decroche
- inference : YOLO sur l'image la plus recente (640x480, < 100 ms/trame vise), puis
              identification des visages (faces.py) quand une personne est presente
- flux      : MJPEG a la cadence de la camera sur http://<host>:8090/stream, avec les
              dernieres detections dessinees ; etat JSON sur /status

Regle d'alarme : le buzzer sonne quand quelqu'un est dans le champ et que la camera n'y
reconnait personne. Une personne autorisee reconnue (ou vue il y a moins de KNOWN_GRACE s)
couvre tout le champ : pas d'alarme, et une alarme en cours est coupee aussitot.

Anti-photo (faces.pose) : un visage autorise ne compte qu'une fois prouve "vivant", c'est-a-dire
quand la tete a un peu tourne (parallaxe du nez, impossible avec une photo ou un ecran plat).
Il a LIVE_WAIT s pour le faire ; au-dela, alarme "spoof" (photo suspectee).

Alertes (POST /api/v1/alerts), toutes confirmees dans le temps (pas sur une seule image) :
- visage inconnu   -> critical + buzzer et LED rouge sur l'ESP (POST /api/v1/command)
- personne sans visage identifiable -> high + buzzer et LED rouge
  (l'alarme est coupee --alarm-hold s apres le depart de l'intrus)
- visage autorise immobile (photo, ecran) -> critical "spoof" + buzzer et LED rouge
- visage autorise  -> info "acces autorise" (une fois par minute et par personne)
Les alarmes envoient aussi {"stranger": true} : l'OLED de l'ESP affiche "personne non
reconnue" si son PIR detecte un mouvement dans les 15 s qui suivent.

Authentification par le visage (POST /auth/face) : l'operateur se place seul devant la camera
et tourne la tete a gauche puis a droite (consigne incrustee dans le flux) ; reconnu sur plusieurs
images et mouvement 3D constate, il recoit un jeton de session signe avec l'API_KEY
(valable SESSION_TTL), accepte par l'API comme la cle. La cle elle-meme ne sort jamais.
"""
import argparse
import base64
import hashlib
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
p.add_argument("--confirm", type=float, default=1.5, help="secondes de presence non reconnue avant alarme")
p.add_argument("--cooldown", type=float, default=10.0, help="secondes entre deux alertes")
p.add_argument("--no-faces", action="store_true", help="desactive la reconnaissance faciale")
p.add_argument("--face-threshold", type=float, default=0.363, help="similarite minimale pour reconnaitre")
p.add_argument("--alarm-hold", type=float, default=10.0, help="secondes sans inconnu avant de couper le buzzer")
p.add_argument("--no-buzzer", action="store_true", help="ne pas declencher le buzzer de l'ESP")
p.add_argument("--no-liveness", action="store_true",
               help="alarme : ne pas exiger de mouvement de tete (la connexion l'exige toujours)")
args = p.parse_args()

W, H = 640, 480
BACKENDS = [("DSHOW", cv2.CAP_DSHOW), ("MSMF", cv2.CAP_MSMF)] if os.name == "nt" else [("ANY", cv2.CAP_ANY)]
CYAN, RED, GREEN, GREY, ORANGE = (255, 230, 62), (92, 59, 255), (154, 245, 43), (150, 150, 150), (32, 176, 255)  # BGR
KNOWN_GRACE = 15.0     # s : une personne autorisee vue recemment couvre le champ (tete tournee...)
ACCESS_COOLDOWN = 60.0  # s entre deux alertes "acces autorise" pour la meme personne
SESSION_TTL = 12 * 3600  # s de validite d'une session ouverte par le visage
AUTH_WINDOW = 12.0      # s laissees a l'operateur pour presenter son visage et tourner la tete
AUTH_HITS = 3           # identifications concordantes exigees (pas une seule image)
# amplitude de pose (faces.pose) : photo tournee, inclinee, en perspective : jusqu'a ~0.23 mesure ;
# vraie tete tournee de 30 degres de chaque cote : ~0.5
AUTH_SPREAD = 0.30      # exigee a la connexion (tourner franchement la tete)
LIVE_SPREAD = 0.25      # exigee pour qu'un visage autorise couvre l'alarme (regarder autour de soi)
LIVE_WINDOW = 10.0      # s d'historique de pose par personne
LIVE_WAIT = 10.0        # s laissees a un visage autorise pour bouger avant l'alarme "photo"
LIVE_GAP = 3.0          # s sans voir la personne : sa preuve de vivacite est oubliee


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
        self.faces_id = 0                     # incremente a chaque inference
        self.enrolling = False                # capture d'un visage en cours : pas d'alarme
        self.auth_msg = ""                    # consigne incrustee dans le flux pendant une connexion
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
        if type_ in ("unknown_face", "intrusion", "spoof"):
            # l'ESP affiche l'ecran "non reconnu" si son PIR voit aussi bouger (meme avec --no-buzzer)
            cmd = {"stranger": True}
            if not args.no_buzzer:
                cmd.update(buzzer=True, led="red")
            api_post("/api/v1/command", cmd)
        elif type_ == "access" and not args.no_buzzer:
            api_post("/api/v1/command", {"chime": "access", "who": data.get("name", "")[:16]})
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


def spread(poses: list[float]) -> float:
    """Amplitude des poses, lissees par mediane sur 3 images (ignore un point de repere aberrant)."""
    med = [sorted(poses[i:i + 3])[1] for i in range(len(poses) - 2)]
    return max(med) - min(med) if med else 0.0


def stop_alarm(reason: str) -> None:
    log(f"[alarme] {reason} : fin de l'alarme")
    if args.no_buzzer:
        return
    threading.Thread(target=api_post, args=("/api/v1/command", {"buzzer": False, "led": "green", "stranger": False}),
                     daemon=True).start()


def inference_loop() -> None:
    seen_id = 0
    presence = Window(args.confirm)
    times: deque = deque(maxlen=10)
    last_alarm = 0.0
    last_access: dict[str, float] = {}
    known_seen = last_intruder = -KNOWN_GRACE
    alarm = False  # alarme en cours (buzzer, sauf --no-buzzer)
    tracks: dict[str, dict] = {}  # par personne autorisee : premiere vue, poses recentes, vivacite
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
        now = time.monotonic()
        for f in faces:  # vivacite des visages autorises (avant publication : le flux l'affiche)
            if not f["name"] or f["small"]:
                continue
            tr = tracks.get(f["name"])
            if tr is None or now - tr["last"] > LIVE_GAP:
                tr = tracks[f["name"]] = {"first": now, "poses": deque(), "live": args.no_liveness}
            tr["last"] = now
            tr["poses"].append((now, f["pose"]))
            while now - tr["poses"][0][0] > LIVE_WINDOW:
                tr["poses"].popleft()
            if not tr["live"] and spread([v for _, v in tr["poses"]]) >= LIVE_SPREAD:
                tr["live"] = True
                log(f"[vivacite] {f['name']} : mouvement de tete constate")
            f["live"] = tr["live"]
            f["since"] = now - tr["first"]
        with S.lock:
            S.boxes, S.faces = boxes, faces
            S.faces_id += 1
            S.persons = len(boxes)
            S.infer_ms = ms
            if len(times) > 1:
                S.infer_fps = (len(times) - 1) / (times[-1] - times[0])
            enrolling = S.enrolling

        judged = [f for f in faces if not f["small"]]
        known = [f for f in judged if f["name"] and f["live"]]
        pending = [f for f in judged if f["name"] and not f["live"] and f["since"] < LIVE_WAIT]
        spoofs = [f for f in judged if f["name"] and not f["live"] and f["since"] >= LIVE_WAIT]
        strangers = [f for f in judged if not f["name"]]
        for f in known:
            known_seen = now
            if now - last_access.get(f["name"], -ACCESS_COOLDOWN) >= ACCESS_COOLDOWN:
                last_access[f["name"]] = now
                alert("access", "info", f"Acces autorise : {f['name']}",
                      {"name": f["name"], "similarity": f["score"]})

        # quelqu'un dans le champ et personne de reconnu : intrus (base vide = tout le monde est inconnu)
        # un visage autorise pas encore prouve vivant couvre le champ pendant LIVE_WAIT s
        covered = now - known_seen < KNOWN_GRACE or bool(pending)
        intruder = bool(boxes) and not covered and not enrolling
        if intruder:
            last_intruder = now
        # nouvelle alarme aussitot ; pendant une alarme, rappel au plus toutes les --cooldown s
        if presence.add(now, intruder) and intruder and (not alarm or now - last_alarm > args.cooldown):
            last_alarm = now
            alarm = True
            if spoofs:
                alert("spoof", "critical", f"Visage de {spoofs[0]['name']} immobile : photo ou ecran suspecte",
                      {"name": spoofs[0]["name"], "similarity": spoofs[0]["score"], "inference_ms": round(ms, 1)})
            elif strangers:
                alert("unknown_face", "critical", f"{len(strangers)} visage(s) inconnu(s)",
                      {"count": len(strangers), "similarity": max(f["score"] for f in strangers),
                       "inference_ms": round(ms, 1)})
            else:
                alert("intrusion", "high", f"{len(boxes)} personne(s) detectee(s)"
                      + (", aucun visage reconnu" if book else ""),
                      {"count": len(boxes), "confidence": round(max(b[4] for b in boxes), 2),
                       "inference_ms": round(ms, 1)})
        # l'alarme s'arrete des qu'une personne autorisee est reconnue, ou quand l'intrus est parti
        if alarm and known:
            alarm = False
            stop_alarm(f"{known[0]['name']} reconnu(e)")
        elif alarm and now - last_intruder > args.alarm_hold:
            alarm = False
            stop_alarm(f"aucun intrus depuis {args.alarm_hold:.0f} s")


# ---------- etage 3 : rendu et flux ----------
def label(img: np.ndarray, text: str, x: int, y: int, color: tuple) -> None:
    (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
    y = max(y, th + 8)
    cv2.rectangle(img, (x, y - th - 8), (x + tw + 8, y), color, -1)
    cv2.putText(img, text, (x + 4, y - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)


def annotate(frame: np.ndarray, boxes: list[tuple], faces: list[dict]) -> np.ndarray:
    out = frame.copy()
    known_centers = [(f["box"][0] + f["box"][2] // 2, f["box"][1] + f["box"][3] // 2)
                     for f in faces if f["name"] and f.get("live", True)]
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
        elif f["name"] and not f.get("live", True):
            color, text = ORANGE, f"{f['name'].upper()} ? BOUGEZ LA TETE"
        elif f["name"]:
            color, text = GREEN, f"{f['name'].upper()} {f['score'] * 100:.0f}%"
        else:
            color, text = RED, "INCONNU"
        cv2.rectangle(out, (x, y), (x + w, y + h), color, 2)
        label(out, text, x, y, color)
    status = f"YOLOv8n {S.infer_ms:.0f} ms | {S.cam_fps:.0f} fps | personnes: {len(boxes)}"
    alarm = bool(boxes) and not known_centers
    if S.auth_msg:  # consigne de connexion par le visage
        cv2.rectangle(out, (0, 0), (W, 40), (0, 0, 0), -1)
        (tw, _), _ = cv2.getTextSize(S.auth_msg, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)
        cv2.putText(out, S.auth_msg, (max(6, (W - tw) // 2), 27), cv2.FONT_HERSHEY_SIMPLEX, 0.6, CYAN, 2, cv2.LINE_AA)
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


# ---------- sessions ouvertes par le visage ----------
# Jeton "sx1.<nom base64url>.<expiration>.<HMAC-SHA256>" signe avec l'API_KEY : l'API (server/api)
# le verifie avec la meme cle, sans base de sessions. Meme verification dans server/api/app/main.py.
def make_token(name: str) -> tuple[str, int]:
    exp = int(time.time() + SESSION_TTL)
    body = f"sx1.{base64.urlsafe_b64encode(name.encode()).decode().rstrip('=')}.{exp}"
    return f"{body}.{hmac.new(API_KEY.encode(), body.encode(), hashlib.sha256).hexdigest()}", exp


def token_ok(token: str) -> bool:
    parts = token.split(".")
    if len(parts) != 4 or parts[0] != "sx1" or not parts[2].isdigit() or int(parts[2]) < time.time():
        return False
    sig = hmac.new(API_KEY.encode(), ".".join(parts[:3]).encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(parts[3].encode(), sig.encode())


def authorized() -> bool:
    key = request.headers.get("X-API-Key", "")
    return bool(API_KEY) and (hmac.compare_digest(key.encode(), API_KEY.encode()) or token_ok(key))


auth_lock = threading.Lock()


@app.route("/auth/face", methods=["POST"])
def auth_face():
    if not API_KEY:
        return jsonify(error="API_KEY absente du detecteur vision"), 503
    if not book:
        return jsonify(error="reconnaissance faciale desactivee (--no-faces)"), 409
    if not book.people:
        return jsonify(error="aucun visage autorise enregistre : connectez-vous avec la cle"), 409
    if not S.camera_ok:
        return jsonify(error="camera indisponible"), 503
    if not auth_lock.acquire(blocking=False):
        return jsonify(error="authentification deja en cours"), 429
    hits: dict[str, int] = {}
    poses: list[float] = []
    crowd = 0
    try:
        with S.lock:
            seen = S.faces_id
        S.auth_msg = "REGARDEZ LA CAMERA"
        deadline = time.monotonic() + AUTH_WINDOW
        while time.monotonic() < deadline:  # images analysees apres la demande uniquement
            time.sleep(0.05)
            with S.lock:
                if S.faces_id == seen:
                    continue
                seen, faces = S.faces_id, [f for f in S.faces if not f["small"]]
            if len(faces) != 1:  # une seule tete : pas de photo tenue a cote d'un vrai visage
                crowd += len(faces) > 1
                S.auth_msg = "UNE SEULE PERSONNE DEVANT LA CAMERA" if faces else "REGARDEZ LA CAMERA"
                continue
            f = faces[0]
            poses.append(f["pose"])
            if f["name"]:
                hits[f["name"]] = hits.get(f["name"], 0) + 1
            name = max(hits, key=hits.get) if hits else None
            if not name or hits[name] < AUTH_HITS:
                continue
            amp = spread(poses)
            if amp < AUTH_SPREAD:
                S.auth_msg = f"{name.upper()} : TOURNEZ LA TETE A GAUCHE PUIS A DROITE"
                continue
            # identite stable : la grande majorite des images identifiees designent la meme personne
            if hits[name] < 0.7 * sum(hits.values()):
                break
            S.auth_msg = f"ACCES AUTORISE : {name.upper()}"
            token, exp = make_token(name)
            log(f"[auth] {name} connecte(e) par reconnaissance faciale (amplitude {amp:.2f})")
            alert("login", "info", f"Connexion par reconnaissance faciale : {name}",
                  {"name": name, "similarity": f["score"], "pose_spread": round(amp, 2)})
            threading.Timer(1.5, lambda: setattr(S, "auth_msg", "")).start()
            return jsonify(token=token, name=name, expires=exp)
    finally:
        auth_lock.release()
        if not S.auth_msg.startswith("ACCES"):
            S.auth_msg = ""
    name = max(hits, key=hits.get) if hits else None
    if name and hits[name] >= AUTH_HITS:
        amp = spread(poses)
        log(f"[auth] {name} reconnu(e) sans mouvement de tete (amplitude {amp:.2f}) : refuse")
        alert("spoof", "high", f"Connexion refusee : visage de {name} immobile (photo ou ecran ?)",
              {"name": name, "pose_spread": round(amp, 2)})
        return jsonify(error="mouvement de tete non detecte : tournez la tete a gauche puis a droite "
                             "(photos et ecrans refuses)"), 401
    log("[auth] echec de connexion par le visage")
    if crowd > 5:
        return jsonify(error="plusieurs visages detectes : une seule personne devant la camera"), 401
    return jsonify(error="visage non reconnu : placez-vous face a la camera, plus pres"), 401


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
    with S.lock:
        S.enrolling = True  # la personne a enregistrer est encore inconnue : pas d'alarme
    try:
        for _ in range(12):  # ~3 s : bouger legerement la tete pour varier les angles
            time.sleep(0.25)
            with S.lock:
                if S.raw is not None and S.raw_id != last_id:
                    frames.append(S.raw.copy())
                    last_id = S.raw_id
    finally:
        with S.lock:
            S.enrolling = False
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
