# Plan Sentinel-X : suivi

Légende : `[x]` fait et **vérifié** · `[~]` fait mais **pas encore testé / partiel** · `[ ]` à faire

Dernière mise à jour : 2026-10-06 (après refonte du dashboard). Cocher au fur et à mesure (et committer ce fichier).

## 0. Cadrage
- [x] Choix d'architecture : option B (PC portable = serveur local)
- [x] Dépôt GitHub créé : `0xBlxck/Sentinel-X`
- [ ] Schémas réseau et flux validés par les coachs (obligatoire selon le sujet)
- [ ] Répartition des filières dans l'équipe (DEV / IA / INFRA / CYBER) notée ici : ______
- [x] Pousser les commits sur GitHub

## 1. Infrastructure (INFRA)
- [x] docker-compose : Mosquitto + PostgreSQL + API
- [x] Mosquitto en TLS (8883), sans accès anonyme, comptes séparés ESP / API
- [x] Base de données : tables `telemetry` et `alerts` créées
- [x] Conteneurs durcis (non-root, `cap_drop`, base non exposée)
- [x] Secrets hors Git (`.env`, certificats, `config.h` ignorés)
- [~] Réseau de table : fonctionne avec le partage de connexion du S25 (2,4 GHz, WPA2)
  - [ ] Point d'accès **dédié et stable** (clé Wi-Fi USB ou routeur myDiL) pour la démo
  - [ ] Plan d'adressage IP documenté (sous-réseau, IP serveur, IP ESP)
- [ ] Supervision CPU / RAM / volume des logs MQTT (MCO)

## 2. Backend / API (DEV)
- [x] `POST /api/v1/alerts` (testé, 401 sans clé, 201 avec)
- [x] `POST /api/v1/command` (buzzer, LED) : l'API publie bien
- [x] `GET /api/v1/telemetry`, `GET /api/v1/alerts`, `GET /api/v1/health`
- [x] Réception MQTT → base de données (68+ mesures réelles de l'ESP)
- [x] WebSocket `/ws` temps réel (vérifié dans Chrome avec le simulateur)

## 3. Dashboard (DEV)
- [x] Centre de commandement refait (sans dépendance, hors Internet) : niveau de menace, tuiles capteurs, courbes avec marqueurs d'anomalie, score IA, journal système
- [x] Courbes température / humidité / gaz, score Isolation Forest (vérifiées dans Chrome)
- [x] Journal des alertes filtrable (source / gravité), alerte critique plein écran avec sirène
- [~] Boutons buzzer / LED + macros (commande publiée, retour ESP à tester)
- [~] Flux webcam intégré avec HUD (à valider avec `vision/detect.py` lancé)
- [ ] Vérifier l'affichage sur le PC de démo (clé API saisie)

## 4. Firmware ESP8266 (IoT)
- [x] Compilation et envoi (PlatformIO) fonctionnent
- [x] DHT22 : lecture OK (~24-28 °C) après remplacement du capteur
- [x] OLED détecté (0x3C)
- [~] OLED : affichage des infos à vérifier visuellement (IP, Wi-Fi, MQTT, mesures)
- [x] Wi-Fi + heure NTP
- [x] MQTT sur TLS avec vérification du certificat (pas de `setInsecure`)
- [ ] PIR HC-SR501 : affiche `mvt=1` en permanence → câblage ou temps de chauffe à vérifier
- [ ] MQ-2 : lit 0 → vérifier câblage, chauffe, et **diviseur de tension sur A0**
- [x] Buzzer actif branché et testé (commande dashboard → pont USB → ESP, accusé `[cmd]`)
- [x] LED bicolore branchée et testée (rouge / verte / off)
- [x] Commande dashboard → ESP (buzzer / LED) testée de bout en bout en pont USB ; [ ] à refaire en Wi-Fi
- [ ] Alimentation de production (bloc 7,5 V sur VIN, **jamais avec l'USB**)

## 5. Intelligence artificielle (IA)
- [x] Isolation Forest écrit et testé sur données simulées
- [~] Isolation Forest sur les vraies mesures (apprentissage en cours, ~60 mesures minimum)
- [ ] Scénario de démo anomalie (chauffer le DHT22, fumée près du MQ-2…) répété
- [~] Détection de personnes YOLOv8-tiny lancée sur la caméra USB (index 0) ; vraie personne à valider
- [x] Temps d'inférence < 100 ms par trame vérifié (58-66 ms)
- [ ] Alerte « intrusion » visible sur le dashboard
- [ ] Documentation de l'IA pour le dossier (choix du modèle, features, limites)

## 6. Cybersécurité
- [x] Chiffrement TLS ESP → serveur prouvé (capture à faire pour le dossier)
- [ ] Preuve matérielle du chiffrement (Wireshark : trafic illisible)
- [ ] Hardening appliqué : `security/harden-windows.ps1` (administrateur)
- [ ] SSH par clés (si serveur Linux / Raspberry)
- [ ] Matrice de sécurité (hardening, TLS) pour le dossier
- [ ] Pentest croisé (jeudi) : Nmap, Wireshark, MitM, injection, DoS
- [ ] Rapport d'audit post-pentest

## 7. Fablab (boîtier)
- [ ] CAO Fusion 360 de la coque (parois ≤ 1,2 mm, fenêtre OLED, passe-câbles)
- [ ] Impression 3D (anticiper, c'est long)
- [ ] Gravure laser : logo AetherCorp, consignes de sécurité, numéro de série
- [ ] Montage final propre (sans fils apparents)

## 8. Livrables (dépôt jeudi soir dans `Workshop2026-M1-G<n>`)
- [ ] `Workshop2026-M1-G<n>-Dossier.pdf` : schéma réseau, câblage, matrice sécurité, doc IA, rapport pentest, poster A3
- [ ] `Workshop2026-M1-G<n>-Pres.pptx`
- [ ] `Workshop2026-M1-G<n>-VidDrop.mp4` : 9:16, H.264, 60 s max, fond vert
  - [ ] 00-10 s : menace / hook
  - [ ] 10-30 s : gros plans du boîtier
  - [ ] 30-50 s : démo fond vert (schémas, code, YOLO)
  - [ ] 50-60 s : outro « Sentinel-X : la sécurité à la bordure »
- [ ] `Workshop2026-M1-G<n>-Code.zip` : dépôt propre, README exhaustif, **aucun secret**
- [ ] Prototype déposé au myDiL le vendredi matin

## 9. Soutenance (vendredi, 10 min)
- [ ] 0:00-1:00 présentation de l'équipe et de l'architecture
- [ ] 1:00-2:00 projection du teaser
- [ ] 2:00-5:00 démo live (alerte capteur + détection webcam)
- [ ] 5:00-10:00 pitch et questions
- [ ] Répétition complète chronométrée
- [ ] **Plan B démo** : réseau de secours si le Wi-Fi tombe (pont USB : `tools/serial_bridge.py`)
