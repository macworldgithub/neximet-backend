#!/usr/bin/env bash
# Ubuntu/Debian, run as root. Reads the shared secret from CALL_TURN_SECRET
# or prompts for it. Does not change application .env files or restart PM2.
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo 'Run this installer as root (or with sudo).' >&2
  exit 1
fi
public_ip=${1:-}
if [[ ! $public_ip =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  echo 'Usage: bash install-coturn.sh PUBLIC_IPV4' >&2
  exit 1
fi
IFS=. read -r -a octets <<< "$public_ip"
for octet in "${octets[@]}"; do
  if (( 10#$octet > 255 )); then echo 'Invalid public IPv4 address.' >&2; exit 1; fi
done
if ! command -v apt-get >/dev/null || ! command -v systemctl >/dev/null; then
  echo 'This installer requires Ubuntu/Debian with systemd.' >&2
  exit 1
fi
turn_secret=${CALL_TURN_SECRET:-}
if [[ -z $turn_secret ]]; then
  read -r -s -p 'Paste the CALL_TURN_SECRET from your backend .env: ' turn_secret
  printf '\n'
fi
if [[ ! $turn_secret =~ ^[a-fA-F0-9]{64}$ ]]; then
  echo 'Use the 64-character hexadecimal secret generated for Neximet.' >&2
  exit 1
fi

umask 077
backup_suffix=$(date -u +%Y%m%dT%H%M%SZ).$$
if [[ -f /etc/turnserver.conf ]]; then
  cp -a /etc/turnserver.conf "/etc/turnserver.conf.neximet-backup.$backup_suffix"
fi

# Write authenticated configuration before installing the package so its
# post-install startup cannot expose an anonymous relay.
cat > /etc/turnserver.conf <<EOF
listening-port=3478
listening-ip=0.0.0.0
external-ip=$public_ip
realm=neximet.com
server-name=neximet-turn
fingerprint
use-auth-secret
static-auth-secret=$turn_secret
min-port=49152
max-port=50175
no-cli
no-tls
no-dtls
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
syslog
EOF
chmod 0600 /etc/turnserver.conf

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get -o Dpkg::Options::=--force-confold install -y coturn
chown root:turnserver /etc/turnserver.conf
chmod 0640 /etc/turnserver.conf

if [[ -f /etc/default/coturn ]]; then
  cp -a /etc/default/coturn "/etc/default/coturn.neximet-backup.$backup_suffix"
  if grep -Eq '^[#[:space:]]*TURNSERVER_ENABLED=' /etc/default/coturn; then
    sed -i 's/^[#[:space:]]*TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
  else
    printf '\nTURNSERVER_ENABLED=1\n' >> /etc/default/coturn
  fi
fi

# Never enable UFW or alter SSH access. Update an already active UFW only.
if command -v ufw >/dev/null && LC_ALL=C ufw status | grep -q '^Status: active'; then
  ufw allow 3478/tcp comment 'Neximet TURN signaling'
  ufw allow 3478/udp comment 'Neximet TURN signaling'
  ufw allow 49152:50175/udp comment 'Neximet TURN media'
fi
systemctl enable coturn
systemctl restart coturn
systemctl is-active --quiet coturn
printf '\nCoturn is active. Set the same secret in the backend .env.\n'
printf 'CALL_TURN_URLS=turn:%s:3478?transport=udp,turn:%s:3478?transport=tcp\n' "$public_ip" "$public_ip"
printf 'Provider firewall ingress required: TCP 3478, UDP 3478, UDP 49152-50175.\n'
printf 'Restart the backend as its PM2 owner after updating .env.\n'
printf 'This IP-based setup uses UDP/TCP TURN. TLS TURN needs a hostname and certificate.\n'
