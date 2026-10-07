# Sentinel-X

Edge Node de surveillance (ESP8266) + centre de commandement local (PC serveur) :
MQTT/TLS, API FastAPI, PostgreSQL, IA (YOLOv8-tiny + Isolation Forest), dashboard temps reel.
Workshop EPSI M1 2026-27, option B (PC apprenant = serveur local).

```
ESP8266 --MQTTS 8883--> Mosquitto --> API (FastAPI) --> PostgreSQL
 (DHT22/MQ-2/PIR/OLED)      ^             |  \-> Isolation Forest (anomalies)
                            |             +-WebSocket-> Dashboard (http://IP:8000)
   commandes buzzer/LED <---+                           ^
                                   Webcam -> vision/detect.py (YOLO) --alertes REST--> API
```

## Structure
| Dossier | Contenu |
|---|---|
| `firmware/` | PlatformIO, C++ ESP8266 |
| `server/` | docker-compose (mosquitto, db, api) |
| `vision/` | detection de personnes sur webcam (sur l'hote, pas dans Docker) |
| `dashboard/` | centre de commandement web (JS natif, sans dependance : fonctionne hors Internet), servi par l'API |
| `tools/` | pont USB -> MQTTS, simulateur de boitier (scenarios de demo) |
| `security/` | PKI/secrets, durcissement Windows et Linux |

## Demarrage
Prerequis : Docker, openssl (Git Bash), Python 3.11+, PlatformIO.

```bash
# 1. Secrets, certificats TLS, mots de passe MQTT et en-tetes firmware
#    (IP du PC serveur sur le Wi-Fi de table, ex 192.168.10.1)
bash security/setup.sh 192.168.10.1 <SSID> <MOT_DE_PASSE_WIFI>

# 2. Stack serveur
cd server && docker compose --env-file ../.env up -d --build

# 3. Firmware (ESP branche en USB, jamais en meme temps que le bloc 7.5V)
cd ../firmware && pio run -t upload && pio device monitor

# 4. Vision (sur le PC, webcam USB)
#    Python du Microsoft Store : pas d'acces webcam. Utiliser un Python standard (ex. uv).
cd ../vision && uv venv .venv --python-preference only-managed --python 3.12
uv pip install --python .venv/Scripts/python.exe -r requirements.txt
.venv/Scripts/python.exe detect.py --list                              # cameras disponibles
API_KEY=<voir .env> .venv/Scripts/python.exe detect.py --camera 0    # flux sur :8090 (8081 = Jenkins)
```
Dashboard : `http://<IP>:8000`, saisir l'API key (`API_KEY` dans `.env`).
Raccourcis : `F` plein ecran, `M` son des alertes, `Echap` acquitter une alerte critique.

Sans ESP (developpement, repetition, plan B de demo) : le simulateur publie sur le broker
avec le compte ESP, les mesures suivent le vrai chemin (MQTT/TLS -> API -> IA -> dashboard).
```bash
uv run --with paho-mqtt python tools/simulate.py --host <IP_DU_CERTIFICAT> --scenario demo
# scenarios : normal | chauffe | fuite | intrusion | demo (apprentissage accelere puis boucle)
```

## Brochage (NodeMCU)
| Composant | Broche |
|---|---|
| DHT22 | D5 (+ sur 3,3 V) |
| PIR HC-SR501 | D6 (VCC sur 5 V = VU) |
| Buzzer actif | D7 |
| LED rouge / verte | D8 / D0 (cathode commune au GND, resistances) |
| OLED SDA / SCL | D2 / D1 |
| MQ-2 AO | A0 (**diviseur de tension obligatoire : AO sort jusqu'a 5 V**) |
| Alimentation | 3V -> rail 3,3 V, VU -> rail 5 V, G -> rails GND (un fil par broche de composant) |

## API
- `POST /api/v1/alerts` (header `X-API-Key`) : `{source,type,severity,message,data}`
- `POST /api/v1/command` : `{buzzer:bool, led:"green|red|off"}`
- `GET /api/v1/alerts`, `GET /api/v1/telemetry`, `GET /api/v1/health`
- `WS /ws?key=...` : flux temps reel

## Securite
- MQTTS (TLS 1.2), certificat serveur verifie par l'ESP (CA embarquee, NTP pour la validite).
- Mosquitto : pas d'anonyme, comptes separes ESP / API, limites de connexions et de taille.
- Conteneurs : non-root, `cap_drop ALL`, `no-new-privileges`, API en lecture seule, DB non exposee.
- Durcissement : `security/harden-windows.ps1` ou `security/harden-linux.sh` (UFW, SSH par cles).
- Aucun secret dans Git : `.env`, certificats, `config.h` sont ignores.

## IA
- **Maintenance predictive** : Isolation Forest (scikit-learn) sur temp, humidite, gaz et leurs pentes ;
  apprentissage glissant apres 60 mesures, aucun seuil statique.
- **Vision** : YOLOv8n, classe `person`, images 640x480, temps d'inference affiche sur le flux.
- **Controle d'acces** : reconnaissance faciale OpenCV (YuNet pour detecter, SFace pour reconnaitre,
  similarite cosinus >= 0.363). Visages autorises ajoutes depuis le dashboard (panneau *Controle d'acces*)
  ou en deposant des photos dans `vision/faces/<nom>/`. Un visage **inconnu** confirme 1,5 s declenche
  une alerte `critical` (sirene sur le dashboard) et le **buzzer + LED rouge** de l'ESP (`--no-buzzer` pour
  desactiver). Tant qu'aucun visage n'est enregistre, seule l'alerte de presence YOLO est active.
  Donnees biometriques : stockees uniquement en local, ignorees par Git, enregistrement avec consentement
  de la personne (RGPD art. 9), suppression depuis le dashboard.
