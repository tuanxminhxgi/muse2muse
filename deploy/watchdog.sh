#!/usr/bin/env bash
# muse-watchdog — giám sát bridge + cloudflared trên PC của Martin (v1.3.0).
# Chạy mỗi 2 phút bằng systemd timer (deploy/muse-watchdog.timer).
#   - Kiểm tra bridge qua GET /health; chết thì restart muse-bridge.service.
#   - Kiểm tra cloudflared; chết thì restart cloudflared.service.
#   - Ghi heartbeat vào watchdog.json để GET /status đọc và hiển thị.
#   - Nếu restart xong vẫn chết thì báo Martin qua Telegram (tối đa 1 lần
#     mỗi 30 phút cho cùng 1 sự cố, tránh spam).
# Không crash khi thiếu systemctl/curl: chỉ ghi log và báo bridgeOk=false.
set -u
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8797}"
HEARTBEAT_FILE="${WATCHDOG_FILE:-$REPO_DIR/watchdog.json}"

# Đọc token Telegram từ .env trong repo (nếu có) để gửi cảnh báo.
if [ -f "$REPO_DIR/.env" ]; then
  # shellcheck disable=SC1091
  set -a; . "$REPO_DIR/.env" 2>/dev/null || true; set +a
fi

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[watchdog $(now_iso)] $*"; }

# Heartbeat trước đó (để đếm số lần restart + tránh báo trùng).
prev_restarts=0; prev_alert=""
if [ -f "$HEARTBEAT_FILE" ]; then
  prev_restarts=$(grep -o '"restarts":[0-9]*' "$HEARTBEAT_FILE" | grep -o '[0-9]*' | head -1 || true)
  prev_alert=$(grep -o '"lastAlertAt":"[^"]*"' "$HEARTBEAT_FILE" | cut -d'"' -f4 || true)
fi
restarts="${prev_restarts:-0}"
last_alert="${prev_alert:-}"

bridge_ok=false
if command -v curl >/dev/null 2>&1; then
  if curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    bridge_ok=true
  fi
else
  log "không có curl — không kiểm tra được bridge"
fi

cloudflared_ok=false
if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active --quiet cloudflared.service && cloudflared_ok=true
elif command -v pgrep >/dev/null 2>&1; then
  pgrep -x cloudflared >/dev/null 2>&1 && cloudflared_ok=true
else
  log "không có systemctl/pgrep — không kiểm tra được cloudflared"
fi

restart_service() {
  # $1 = tên service. Trả 0 nếu đã gọi restart (hoặc không có systemctl).
  if command -v systemctl >/dev/null 2>&1; then
    log "restart $1..."
    systemctl restart "$1" 2>/dev/null || log "không restart được $1 (cần quyền? xem README)"
  else
    log "không có systemctl — không tự restart được $1, cần restart tay"
  fi
  restarts=$((restarts + 1))
}

if [ "$bridge_ok" = false ]; then
  log "bridge KHÔNG phản hồi /health — thử restart muse-bridge.service"
  restart_service muse-bridge.service
  sleep 5
  if command -v curl >/dev/null 2>&1 && curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    bridge_ok=true
    log "bridge đã lên lại sau restart"
  else
    log "bridge VẪN chết sau restart"
  fi
fi

if [ "$cloudflared_ok" = false ]; then
  log "cloudflared không chạy — thử restart cloudflared.service"
  restart_service cloudflared.service
  sleep 3
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet cloudflared.service; then
    cloudflared_ok=true
    log "cloudflared đã lên lại sau restart"
  fi
fi

# Cảnh báo Telegram nếu bridge vẫn chết: tối đa 1 lần/30 phút.
if [ "$bridge_ok" = false ] && [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ] && command -v curl >/dev/null 2>&1; then
  alert_due=true
  if [ -n "$last_alert" ]; then
    last_epoch=$(date -d "$last_alert" +%s 2>/dev/null || echo 0)
    now_epoch=$(date +%s)
    [ $((now_epoch - last_epoch)) -lt 1800 ] && alert_due=false
  fi
  if [ "$alert_due" = true ]; then
    if curl -fsS --max-time 10 -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        -H 'content-type: application/json' \
        -d "{\"chat_id\":\"${TELEGRAM_CHAT_ID}\",\"text\":\"[watchdog] Bridge muse2muse trên PC KHÔNG phản hồi, đã thử restart mà vẫn chết. Kiểm tra PC giúp mình nhé.\"}" >/dev/null 2>&1; then
      last_alert=$(now_iso)
      log "đã báo Telegram: bridge chết"
    else
      log "gửi cảnh báo Telegram thất bại"
    fi
  fi
fi

# Ghi heartbeat để GET /status đọc.
{
  printf '{"checkedAt":"%s","bridgeOk":%s,"cloudflaredOk":%s,"restarts":%s,"lastAlertAt":%s}\n' \
    "$(now_iso)" "$bridge_ok" "$cloudflared_ok" "$restarts" \
    "$([ -n "$last_alert" ] && printf '"%s"' "$last_alert" || printf 'null')"
} > "$HEARTBEAT_FILE.tmp" && mv "$HEARTBEAT_FILE.tmp" "$HEARTBEAT_FILE"

log "xong: bridgeOk=$bridge_ok cloudflaredOk=$cloudflared_ok restarts=$restarts"
exit 0
