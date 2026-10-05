#!/usr/bin/env bash
# Génère une CA locale et un certificat serveur (RSA 2048, compatible BearSSL/ESP8266).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f ../.env ] && set -a && . ../.env && set +a
SERVER_IP="${SERVER_IP:-192.168.10.1}"
OUT=certs
mkdir -p "$OUT"

openssl genrsa -out "$OUT/ca.key" 2048
openssl req -x509 -new -nodes -key "$OUT/ca.key" -sha256 -days 365 \
  -subj "/O=AetherCorp/CN=Sentinel-X CA" -out "$OUT/ca.crt"

openssl genrsa -out "$OUT/server.key" 2048
openssl req -new -key "$OUT/server.key" -subj "/O=AetherCorp/CN=$SERVER_IP" -out "$OUT/server.csr"
printf "subjectAltName=IP:%s,DNS:localhost,IP:127.0.0.1\n" "$SERVER_IP" > "$OUT/san.ext"
openssl x509 -req -in "$OUT/server.csr" -CA "$OUT/ca.crt" -CAkey "$OUT/ca.key" \
  -CAcreateserial -out "$OUT/server.crt" -days 365 -sha256 -extfile "$OUT/san.ext"

rm -f "$OUT/server.csr" "$OUT/san.ext"
# Mosquitto (uid 1883 dans le conteneur) doit pouvoir lire la clé
chmod 644 "$OUT/server.key"
chmod 600 "$OUT/ca.key"
echo "Certificats générés dans infra/$OUT (ca.crt à embarquer dans le firmware)"
