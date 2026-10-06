"""Detection d'anomalies sur series temporelles (Isolation Forest, sans seuil statique).

Features par mesure : temperature, humidite, gaz, + pentes (variation depuis la
mesure precedente) pour capter une hausse lente de temperature couplee a une
micro-deviation de gaz avant tout seuil critique.
"""
from collections import deque
from threading import Lock

import numpy as np
from sklearn.ensemble import IsolationForest

MIN_TRAIN = 60       # mesures minimum avant d'entrainer
WINDOW = 600         # fenetre glissante d'apprentissage
REFIT_EVERY = 30     # re-entrainement toutes les N mesures
PERSIST = 10         # N anomalies consecutives = nouveau regime normal (derive lente, changement de piece)


class AnomalyDetector:
    def __init__(self) -> None:
        self._rows: deque = deque(maxlen=WINDOW)
        self._last: tuple | None = None
        self._model: IsolationForest | None = None
        self._since_fit = 0
        self._streak = 0
        self._lock = Lock()

    @property
    def ready(self) -> bool:
        return self._model is not None

    def _features(self, temp: float, hum: float, gas: float) -> list[float]:
        if self._last is None:
            d = (0.0, 0.0, 0.0)
        else:
            d = (temp - self._last[0], hum - self._last[1], gas - self._last[2])
        return [temp, hum, gas, *d]

    def update(self, temp: float, hum: float, gas: float) -> tuple[float | None, bool]:
        """Ajoute une mesure, retourne (score, is_anomaly). Score None tant que non entraine."""
        with self._lock:
            x = self._features(temp, hum, gas)
            self._last = (temp, hum, gas)
            score, anomaly = None, False
            if self._model is not None:
                arr = np.array([x])
                score = float(self._model.decision_function(arr)[0])
                anomaly = bool(self._model.predict(arr)[0] == -1)
            # On n'apprend pas sur les points anormaux (evite la derive), sauf si l'etat
            # anormal persiste : c'est alors un nouveau regime de fonctionnement.
            self._streak = self._streak + 1 if anomaly else 0
            if not anomaly or self._streak >= PERSIST:
                self._rows.append(x)
                self._since_fit += 1
            if len(self._rows) >= MIN_TRAIN and (self._model is None or self._since_fit >= REFIT_EVERY):
                self._model = IsolationForest(
                    n_estimators=100, contamination=0.02, random_state=42
                ).fit(np.array(self._rows))
                self._since_fit = 0
            return score, anomaly
