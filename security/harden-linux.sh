#!/usr/bin/env bash
# Durcissement si le serveur est sous Linux (ex: Raspberry Pi). A lancer en root.
set -euo pipefail
SUBNET="${1:-192.168.10.0/24}"

ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow from "$SUBNET" to any port 22 proto tcp
ufw allow from "$SUBNET" to any port 8883 proto tcp
ufw allow from "$SUBNET" to any port 8000 proto tcp
ufw allow from "$SUBNET" to any port 8081 proto tcp
ufw --force enable

# SSH : cles uniquement, pas de root
sed -i -E 's/^#?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i -E 's/^#?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i -E 's/^#?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config
systemctl restart ssh || systemctl restart sshd
echo "Hardening applique. Verifier: ufw status verbose ; sshd -T | grep -i passwordauth"
