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
# Raspberry Pi OS ships a drop-in forcing Storage=volatile (SD-card protection); a later drop-in wins.
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nStorage=persistent\nSystemMaxUse=200M\n' > /etc/systemd/journald.conf.d/persistent.conf
mkdir -p /var/log/journal
systemctl restart systemd-journald
journalctl --flush
# Wi-Fi power save off (2 = disable); re-activating the connection applies it and briefly drops the link.
nmcli con modify "$CON" 802-11-wireless.powersave 2
echo "installed; re-activating $CON"
nohup sh -c 'sleep 1; nmcli con up "'"$CON"'"' >/dev/null 2>&1 &
