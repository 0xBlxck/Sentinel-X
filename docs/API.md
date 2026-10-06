# Guide DEV : interface de supervision

Le dashboard (`dashboard/index.html`, `app.css`, `app.js`) est en JS natif **sans aucune dépendance externe** :
il fonctionne sur le Wi-Fi de table sans Internet (graphiques canvas maison, aucun CDN).
L'équipe DEV peut le refaire ou l'améliorer (React, Vue ou JS natif, au choix du sujet) sans toucher au reste :
il suffit de respecter le contrat ci-dessous. L'API sert la page sur `http://<IP>:8000/`.

## Lancer l'environnement
Voir le README (`security/setup.sh`, puis `docker compose --env-file ../.env up -d --build` dans `server/`).
La clé d'API est dans `.env` (`API_KEY=`). **Ne jamais la committer.**
Pour développer sans l'ESP : `python tools/serial_bridge.py` (ESP en USB) ou le simulateur
`uv run --with paho-mqtt python tools/simulate.py --host <IP> --scenario demo`.

## Authentification
Toutes les routes (sauf `/api/v1/health` et `/`) exigent l'en-tête `X-API-Key: <clé>`.
Le WebSocket prend la clé en paramètre : `ws://<IP>:8000/ws?key=<clé>`.

## Routes
| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/v1/health` | `{status, model_ready, mqtt}` (sans clé) |
| GET | `/api/v1/telemetry?limit=200` | dernières mesures (max 2000), ordre chronologique |
| GET | `/api/v1/alerts?limit=50` | dernières alertes (max 500), plus récentes d'abord |
| POST | `/api/v1/alerts` | crée une alerte `{source, type, severity, message?, data?}` |
| POST | `/api/v1/command` | commande l'ESP : `{buzzer?: bool, led?: "green"\|"red"\|"off"}` |
| WS | `/ws?key=...` | flux temps réel (voir ci-dessous) |

`severity` : `info`, `medium`, `high`, `critical`.

## Messages WebSocket
Mesure (toutes les ~2 s) :
```json
{"kind":"telemetry","temp":23.3,"hum":79.0,"gas":0,"motion":false,"score":0.12,"anomaly":false,"model_ready":true}
```
Alerte :
```json
{"kind":"alert","id":42,"ts":"2026-10-06T08:15:59+00:00","source":"vision","type":"intrusion","severity":"high","message":"1 personne(s) detectee(s)","data":{"count":1,"confidence":0.87,"inference_ms":63.1}}
```
Sources d'alertes : `ml` (anomalie Isolation Forest), `vision` (intrusion YOLO), `esp8266` (mouvement PIR).

## Flux caméra
Le script `vision/detect.py` expose un flux MJPEG annoté sur `http://<IP>:8090/stream`
(à mettre dans une balise `<img>`). Il faut le lancer sur le PC serveur (voir README).
État JSON (sans clé) : `GET :8090/status` → `{camera, cam_fps, infer_ms, persons, faces:[{name, score, small}]}`.

Visages autorisés (en-tête `X-API-Key`) : `GET :8090/faces`, `POST :8090/faces {name}` (capture ~3 s),
`DELETE :8090/faces/<nom>`. Nouveaux types d'alerte vision : `unknown_face` (critical), `access` (info).
Le WebSocket diffuse aussi `{"kind":"command", buzzer?, led?}` à chaque commande d'actionneur.

## Idées d'amélioration (au choix)
- Écran d'état du boîtier (Wi-Fi, MQTT, modèle IA prêt ou en apprentissage)
- Historique des alertes filtrable par source / gravité, avec son sonore pour `high`/`critical`
- Vue « alerte critique » plein écran pour la démo
- Retour visuel des commandes (état du buzzer et de la LED)
- Responsive pour la projection en soutenance

## Règles du dépôt
- Un commit par changement logique, message sémantique (`feat(dashboard): ...`, `fix(...)`) : c'est noté (critère « Rigueur Git »).
- Aucun secret en clair : la clé d'API se saisit dans l'interface, elle n'est jamais écrite dans le code.
