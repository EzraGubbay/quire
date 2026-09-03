#!/bin/bash
# One-time setup of a fresh Raspberry Pi OS Lite (Trixie, arm64) as the Quire host.
# Run from the laptop:   ssh -t researchpi 'sudo bash -s' < infra/pi/bootstrap.sh
set -euo pipefail
DEPLOY_USER=${DEPLOY_USER:-ezragubbay}

echo "== packages"
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates curl git jq ufw unattended-upgrades apt-listchanges fail2ban

echo "== docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
usermod -aG docker "$DEPLOY_USER"
systemctl enable --now docker

echo "== layout"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" /srv/quire /srv/quire/runner

echo "== unattended upgrades"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF

echo "== firewall (ssh only inbound; the app is reached through the tunnel)"
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable

echo "== journald cap"
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=200M\n' > /etc/systemd/journald.conf.d/quire.conf
systemctl restart systemd-journald

echo "== done. Log out and back in for docker group membership. Next: infra/pi/install-runner.sh"
