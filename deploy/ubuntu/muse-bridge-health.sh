#!/bin/bash
# Healthcheck for Muse Bridge on Ubuntu 24/7.
# Run every 5 minutes via cron. Restarts the bridge if /health fails,
# and notifies Martin on Telegram if bot token + chat id are set.
set -u
if [ -f /etc/muse-bridge.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /etc/muse-bridge.env
  set +a
fi
if ! curl -fsS --max-time 10 "http://127.0.0.1:8797/health" >/dev/null 2>&1; then
  systemctl restart muse-bridge.service
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage"       -d chat_id="${TELEGRAM_CHAT_ID}"       -d text="Muse Bridge /health failed, da restart lai luc $(date '+%H:%M %d/%m')" >/dev/null 2>&1 || true
  fi
  exit 1
fi
exit 0
