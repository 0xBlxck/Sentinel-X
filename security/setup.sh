#!/usr/bin/env bash
# Genere .env (secrets aleatoires), PKI (CA + cert serveur), mots de passe Mosquitto
# et les en-tetes du firmware. Usage: bash security/setup.sh <IP_DU_PC_SERVEUR> [SSID] [WIFI_PASS]
# Necessite: openssl, docker.
set -euo pipefail
cd "$(dirname "$0")/.."

SERVER_IP="${1:?usage: setup.sh <IP_DU_PC_SERVEUR> [SSID] [WIFI_PASS]}"
SSID="${2:-SentinelX}"
WIFI_PASS="${3:-change-me}"
rand() { openssl rand -hex 16; }

if [ ! -f .env ]; then
  sed -e "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(rand)/" \
      -e "s/^API_KEY=.*/API_KEY=$(rand)/" \
      -e "s/^MQTT_API_PASSWORD=.*/MQTT_API_PASSWORD=$(rand)/" \
      -e "s/^MQTT_ESP_PASSWORD=.*/MQTT_ESP_PASSWORD=$(rand)/" .env.example > .env
  echo "[+] .env cree"
fi
set -a; . ./.env; set +a

CERTS=server/mosquitto/certs
mkdir -p "$CERTS"
if [ ! -f "$CERTS/ca.crt" ]; then
  MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes -days 365 -keyout "$CERTS/ca.key" \
    -out "$CERTS/ca.crt" -subj "/CN=SentinelX-CA"
  MSYS_NO_PATHCONV=1 openssl req -newkey rsa:2048 -nodes -keyout "$CERTS/server.key" \
    -out "$CERTS/server.csr" -subj "/CN=$SERVER_IP"
  printf "subjectAltName=IP:%s\n" "$SERVER_IP" > "$CERTS/san.ext"
  openssl x509 -req -in "$CERTS/server.csr" -CA "$CERTS/ca.crt" -CAkey "$CERTS/ca.key" \
    -CAcreateserial -out "$CERTS/server.crt" -days 365 -extfile "$CERTS/san.ext"
  chmod 644 "$CERTS"/server.key  # lisible par l'utilisateur mosquitto dans le conteneur
  echo "[+] PKI generee pour $SERVER_IP"
fi

PASSWD=server/mosquitto/passwd
: > "$PASSWD"
for pair in "$MQTT_API_USER:$MQTT_API_PASSWORD" "$MQTT_ESP_USER:$MQTT_ESP_PASSWORD"; do
  u="${pair%%:*}"; p="${pair#*:}"
  docker run --rm -v "$(pwd -W 2>/dev/null || pwd)/server/mosquitto:/m" eclipse-mosquitto:2 \
    mosquitto_passwd -b /m/passwd "$u" "$p"
done
echo "[+] passwd Mosquitto genere"

# En-tetes firmware (gitignores)
cat > firmware/include/config.h <<EOF
#pragma once
#define WIFI_SSID "$SSID"
#define WIFI_PASS "$WIFI_PASS"
#define MQTT_HOST "$SERVER_IP"
#define MQTT_PORT 8883
#define MQTT_USER "$MQTT_ESP_USER"
#define MQTT_PASSWORD "$MQTT_ESP_PASSWORD"
EOF
{
  echo '#pragma once'
  echo '#include <pgmspace.h>'
  echo 'static const char CA_CERT[] PROGMEM = R"EOF('
  cat "$CERTS/ca.crt"
  echo ')EOF";'
} > firmware/include/certs.h
echo "[+] firmware/include/config.h et certs.h generes"
echo "API key dashboard : $API_KEY"
