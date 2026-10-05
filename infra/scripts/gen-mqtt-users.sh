#!/usr/bin/env bash
# Crée infra/mosquitto/config/passwd à partir du .env (mots de passe hachés).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a && . ../.env && set +a
PASSWD=mosquitto/config/passwd
: > "$PASSWD"
for pair in "$MQTT_ESP_USER:$MQTT_ESP_PASSWORD" "$MQTT_BACKEND_USER:$MQTT_BACKEND_PASSWORD"; do
  docker run --rm -v "$PWD/mosquitto/config:/c" eclipse-mosquitto:2 \
    mosquitto_passwd -b /c/passwd "${pair%%:*}" "${pair#*:}"
done
chmod 644 "$PASSWD"
echo "Fichier passwd généré"
