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
| `mobile/` | application mobile Expo (iOS / Android) : memes ecrans et commandes que le dashboard |
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
Dashboard : `http://<IP>:8000`. Connexion au choix : **reconnaissance faciale** (se placer devant la webcam
du PC serveur, visage deja enregistre) ou **cle d'API** (`API_KEY` dans `.env`).
Raccourcis : `F` plein ecran, `M` son des alertes, `Echap` acquitter une alerte critique.

Sans ESP (developpement, repetition, plan B de demo) : le simulateur publie sur le broker
avec le compte ESP, les mesures suivent le vrai chemin (MQTT/TLS -> API -> IA -> dashboard).
```bash
uv run --with paho-mqtt python tools/simulate.py --host <IP_DU_CERTIFICAT> --scenario demo
# scenarios : normal | chauffe | fuite | intrusion | demo (apprentissage accelere puis boucle)
```

## Application mobile
```bash
cd mobile && npm install && npx expo start   # scanner le QR code avec Expo Go (SDK 57)
```
Le telephone doit etre sur le meme Wi-Fi que le PC serveur. Au lancement : adresse du PC (ex. `172.20.10.12`)
puis reconnaissance faciale (camera du PC) ou cle d'API ; cle ou jeton de session stocke chiffre sur l'appareil. Onglets : Supervision, Vision, Actionneurs, Alertes, Journal.
Si le telephone ne joint pas Metro (pare-feu Windows), lancer `npx expo start --tunnel`.

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
- `POST :8090/auth/face` (vision, sans cle) : connexion par le visage, renvoie un jeton de session (12 h)
  accepte partout a la place de la cle

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
  ou en deposant des photos dans `vision/faces/<nom>/`. Regle d'alarme : si quelqu'un est dans le champ
  pendant 1,5 s **sans qu'aucune personne autorisee n'y soit reconnue**, le **buzzer + LED rouge** de l'ESP
  sonnent (`--no-buzzer` pour desactiver), avec une alerte `critical` (visage inconnu) ou `high` (visage non
  visible). Une personne autorisee reconnue (ou vue dans les 15 s) couvre le champ : pas d'alarme, et une
  alarme en cours s'arrete aussitot. Sans visage enregistre, toute presence declenche l'alarme.
- **Anti-photo (vivacite)** : avec les 5 points de YuNet, on mesure la position du nez dans le repere
  yeux/bouche. Sur une photo ou un ecran (plats), elle ne change pas quand on bouge le support ; sur une vraie
  tete qui tourne, le nez se decale (parallaxe 3D). Un visage autorise ne coupe l'alarme qu'apres un mouvement
  de tete ; immobile plus de 10 s, il declenche l'alarme `spoof` (photo suspectee). `--no-liveness` desactive
  cette exigence pour l'alarme. Limite : une video de la personne qui tourne la tete pourrait passer.
- **Connexion par le visage** : une seule personne devant la camera, reconnue sur 3 images et qui tourne la tete
  a gauche puis a droite (consigne incrustee dans le flux), en 12 s, uniquement sur des images prises apres la
  demande ; jeton signe HMAC-SHA256 avec l'`API_KEY` (la cle ne quitte jamais le serveur), alerte `login`
  journalisee ; une photo reconnue mais immobile est refusee et journalisee (`spoof`).
  Donnees biometriques : stockees uniquement en local, ignorees par Git, enregistrement avec consentement
  de la personne (RGPD art. 9), suppression depuis le dashboard.
