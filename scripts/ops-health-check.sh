#!/usr/bin/env bash
set -euo pipefail

HEALTH_URL="${KAHADE_HEALTH_URL:-https://api.kahade.id/v1/health}"
WEBHOOK_URL="${KAHADE_WEBHOOK_HEALTH_URL:-https://api.kahade.id/v1/health/webhooks}"
CRON_URL="${KAHADE_CRON_HEALTH_URL:-https://api.kahade.id/v1/health/crons}"
READY_URL="${KAHADE_READY_URL:-http://127.0.0.1:3000/v1/health/internal-ready}"
STATE_DIR="${KAHADE_OPS_STATE_DIR:-/var/lib/kahade}"
LOG_FILE="${KAHADE_OPS_LOG_FILE:-/var/log/kahade/ops-health.log}"
NODE_BIN="${KAHADE_NODE_BIN:-/home/kahade/.nvm/versions/node/v20.20.2/bin/node}"
mkdir -p "$STATE_DIR" "$(dirname "$LOG_FILE")"

now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
log_event() {
  local level="$1" message="$2"
  printf '%s level=%s %s\n' "$now" "$level" "$message" >> "$LOG_FILE"
  logger -t kahade-ops "level=$level $message" 2>/dev/null || true
}

health_payload="$(curl -fsS --max-time 15 "$HEALTH_URL" 2>/dev/null || true)"
if [ -z "$health_payload" ]; then
  log_event CRITICAL "main health endpoint unavailable url=$HEALTH_URL"
  exit 1
fi

disk_values="$(printf '%s' "$health_payload" | "$NODE_BIN" -e '
let input=""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => {
  try {
    const d = JSON.parse(input);
    const disk = d?.data?.info?.disk || {};
    process.stdout.write(`${Number(disk.usedPercent ?? -1)}|${Number(disk.freeMb ?? -1)}|${d?.data?.status ?? "unknown"}`);
  } catch { process.stdout.write("-1|-1|invalid"); }
});')"
IFS='|' read -r used_percent free_mb app_status <<< "$disk_values"

if [ "$used_percent" -ge 85 ] 2>/dev/null; then
  log_event CRITICAL "disk usage=${used_percent}% freeMb=${free_mb} appStatus=${app_status}"
elif [ "$used_percent" -ge 70 ] 2>/dev/null; then
  log_event WARNING "disk usage=${used_percent}% freeMb=${free_mb} appStatus=${app_status}"
fi

webhook_code="$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' "$WEBHOOK_URL" || true)"
if [ "$webhook_code" != "200" ]; then
  log_event CRITICAL "webhook health http=$webhook_code url=$WEBHOOK_URL"
fi

cron_code="$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' "$CRON_URL" || true)"
if [ "$cron_code" != "200" ]; then
  log_event CRITICAL "cron health http=$cron_code url=$CRON_URL"
fi

ready_code="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "$READY_URL" || true)"
if [ "$ready_code" != "200" ]; then
  log_event CRITICAL "internal readiness http=$ready_code url=$READY_URL"
fi

if [ "$app_status" != "ok" ] && [ "$app_status" != "up" ]; then
  log_event CRITICAL "application health status=$app_status url=$HEALTH_URL"
fi

printf '%s\n' "disk_percent=$used_percent free_mb=$free_mb app_status=$app_status webhook_http=$webhook_code cron_http=$cron_code ready_http=$ready_code checked_at=$now" > "$STATE_DIR/ops-health.last"
if [ "$used_percent" -ge 85 ] 2>/dev/null || [ "$webhook_code" != "200" ] || [ "$cron_code" != "200" ] || [ "$ready_code" != "200" ] || { [ "$app_status" != "ok" ] && [ "$app_status" != "up" ]; }; then
  exit 1
fi
