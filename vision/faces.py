"""Reconnaissance faciale : liste blanche de visages autorises.

OpenCV integre (aucune dependance en plus) :
- YuNet  : detection des visages et de 5 points de repere
- SFace  : signature de 128 valeurs par visage aligne, comparee par similarite cosinus

Les visages sont stockes en local dans vision/faces/<nom>/*.jpg (ignore par Git :
donnees biometriques). On peut aussi y deposer des photos classiques : le visage
y est detecte et aligne au chargement.
"""
import re
import shutil
import threading
import time
import urllib.request
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent
MODELS = ROOT / "models"
FACES = ROOT / "faces"
ZOO = "https://github.com/opencv/opencv_zoo/raw/main/models/"
DET = ("face_detection_yunet", "face_detection_yunet_2023mar.onnx")
REC = ("face_recognition_sface", "face_recognition_sface_2021dec.onnx")
NAME_RE = re.compile(r"^[A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9 _-]{0,31}$")  # pas de / ni de .. : nom = dossier


def fetch(folder: str, name: str) -> str:
    path = MODELS / name
    if not path.exists():
        MODELS.mkdir(exist_ok=True)
        print(f"[visages] telechargement du modele {name}", flush=True)
        urllib.request.urlretrieve(f"{ZOO}{folder}/{name}", path)
    return str(path)


def valid_name(name: str) -> bool:
    return bool(NAME_RE.match(name or "")) and name.strip() == name


class FaceBook:
    def __init__(self, threshold: float = 0.363, min_size: int = 60) -> None:
        # 0.363 : seuil cosinus recommande pour SFace (au-dessus = meme personne)
        self.det = cv2.FaceDetectorYN.create(fetch(*DET), "", (320, 320), 0.85, 0.3, 5000)
        self.rec = cv2.FaceRecognizerSF.create(fetch(*REC), "")
        self.threshold, self.min_size = threshold, min_size
        self.lock = threading.Lock()          # les modeles OpenCV ne sont pas thread-safe
        self.people: dict[str, np.ndarray] = {}
        self.reload()

    # ---------- primitives ----------
    def _detect(self, img: np.ndarray) -> np.ndarray:
        h, w = img.shape[:2]
        self.det.setInputSize((w, h))
        _, faces = self.det.detect(img)
        return np.empty((0, 15)) if faces is None else faces

    def _feature(self, crop: np.ndarray) -> np.ndarray:
        f = self.rec.feature(crop).flatten()
        return f / (np.linalg.norm(f) + 1e-9)

    def _largest(self, img: np.ndarray):
        faces = self._detect(img)
        return max(faces, key=lambda f: f[2] * f[3]) if len(faces) else None

    # ---------- base de visages ----------
    def reload(self) -> None:
        people = {}
        FACES.mkdir(exist_ok=True)
        with self.lock:
            for d in sorted(p for p in FACES.iterdir() if p.is_dir()):
                feats = []
                for f in sorted(d.glob("*.jp*g")) + sorted(d.glob("*.png")):
                    img = cv2.imread(str(f))
                    if img is None:
                        continue
                    if img.shape[:2] != (112, 112):  # photo classique : detecter et aligner
                        face = self._largest(img)
                        if face is None:
                            print(f"[visages] aucun visage dans {f.name}, ignore", flush=True)
                            continue
                        img = self.rec.alignCrop(img, face)
                    feats.append(self._feature(img))
                if feats:
                    people[d.name] = np.array(feats)
            self.people = people
        print(f"[visages] {len(people)} personne(s) autorisee(s) : {', '.join(people) or 'aucune'}", flush=True)

    def names(self) -> list[dict]:
        with self.lock:
            return [{"name": n, "samples": len(f)} for n, f in self.people.items()]

    def enroll(self, name: str, frames: list[np.ndarray]) -> int:
        """Enregistre le plus grand visage net de chaque image. Retourne le nombre d'echantillons."""
        folder = FACES / name
        added = []
        with self.lock:
            for img in frames:
                face = self._largest(img)
                if face is None or min(face[2], face[3]) < 80:  # trop loin : signature peu fiable
                    continue
                crop = self.rec.alignCrop(img, face)
                folder.mkdir(parents=True, exist_ok=True)
                cv2.imwrite(str(folder / f"{int(time.time() * 1000)}_{len(added)}.jpg"), crop)
                added.append(self._feature(crop))
            if added:
                old = self.people.get(name)
                self.people[name] = np.vstack([old, added]) if old is not None else np.array(added)
        return len(added)

    def delete(self, name: str) -> bool:
        with self.lock:
            if name not in self.people and not (FACES / name).exists():
                return False
            self.people.pop(name, None)
            shutil.rmtree(FACES / name, ignore_errors=True)
        return True

    # ---------- identification ----------
    def identify(self, img: np.ndarray) -> list[dict]:
        """Pour chaque visage : boite, nom (None = inconnu), similarite, et 'small' si trop loin pour juger."""
        out = []
        with self.lock:
            for face in self._detect(img):
                x, y, w, h = (int(v) for v in face[:4])
                f = self._feature(self.rec.alignCrop(img, face))
                name, score = None, 0.0
                for person, feats in self.people.items():
                    s = float(np.max(feats @ f))
                    if s > score:
                        name, score = person, s
                known = score >= self.threshold
                out.append({"box": (x, y, w, h), "name": name if known else None,
                            "score": round(score, 3), "small": min(w, h) < self.min_size})
        return out
