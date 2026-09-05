#!/usr/bin/env bash
# Run once on the Pi with sudo: disables Wi-Fi power saving (drops the link under low traffic), installs the
# net-watchdog timer, and makes the systemd journal persistent so outages keep their logs across reboots.
set -euo pipefail
CON="${NET_WATCHDOG_CON:-Home WiFi}"
DIR="$(cd "$(dirname "$0")" && pwd)"
install -m 755 "$DIR/net-watchdog.sh" /usr/local/sbin/net-watchdog
cat > /etc/systemd/system/net-watchdog.service <<UNIT
[Unit]
Description=Bounce Wi-Fi when the internet stays unreachable
[Service]
Type=oneshot
Environment=NET_WATCHDOG_CON=$CON
ExecStart=/usr/local/sbin/net-watchdog
UNIT
cat > /etc/systemd/system/net-watchdog.timer <<UNIT
[Unit]
Description=Check internet reachability every 2 minutes
[Timer]
OnBootSec=3min
OnUnitActiveSec=2min
AccuracySec=30s
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now net-watchdog.timer
# Persistent journal.
sed -i 's/^#\?Storage=.*/Storage=persistent/' /etc/systemd/journald.conf
mkdir -p /var/log/journal
systemd-tmpfiles --create --prefix /var/log/journal
systemctl restart systemd-journald
# Wi-Fi power save off (2 = disable); re-activating the connection applies it and briefly drops the link.
nmcli con modify "$CON" 802-11-wireless.powersave 2
echo "installed; re-activating $CON"
nohup sh -c 'sleep 1; nmcli con up "'"$CON"'"' >/dev/null 2>&1 &
