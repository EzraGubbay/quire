#!/usr/bin/env bash
# Runs every 2 minutes from net-watchdog.timer. If the internet stays unreachable for three checks in a row,
# bounces the Wi-Fi connection so the Cloudflare tunnel comes back without a manual reboot
# (on 2026-09-05 the Pi's Wi-Fi went dead for six hours; a reboot fixed it).
set -u
STATE=/run/net-watchdog.fail
CON="${NET_WATCHDOG_CON:-Home WiFi}"
if ping -c 2 -W 3 1.1.1.1 >/dev/null 2>&1 || ping -c 2 -W 3 8.8.8.8 >/dev/null 2>&1; then
  rm -f "$STATE"
  exit 0
fi
n=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$STATE"
logger -t net-watchdog "internet unreachable ($n consecutive checks)"
if (( n >= 3 )); then
  logger -t net-watchdog "bouncing Wi-Fi connection '$CON'"
  nmcli con down "$CON" || true
  sleep 3
  nmcli con up "$CON" || true
  echo 0 > "$STATE"
fi
