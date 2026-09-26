#!/usr/bin/env bash
# storage-disk-check.sh — Batch 1A (ST-015)
#
# Cek penggunaan disk /var/www/kahade-storage. Dijadwalkan via cron, mis:
#   */30 * * * * /var/www/kahade-current/deploy/storage-disk-check.sh >> /var/log/kahade-storage-disk.log 2>&1
#
# Keluar 0 bila OK, 1 bila peringatan (dipakai monitoring eksternal bila ada).
set -u

STORAGE_PATH="${STORAGE_PATH:-/var/www/kahade-storage}"
WARN_PCT="${STORAGE_WARN_PCT:-80}"
CRIT_PCT="${STORAGE_CRIT_PCT:-92}"

if [ ! -d "$STORAGE_PATH" ]; then
  echo "$(date -u +%FT%TZ) CRITICAL: storage path $STORAGE_PATH does not exist"
  exit 1
fi

PCT=$(df -P "$STORAGE_PATH" | awk 'NR==2 {gsub(/%/, "", $5); print $5}')
if [ -z "$PCT" ]; then
  echo "$(date -u +%FT%TZ) CRITICAL: unable to read disk usage for $STORAGE_PATH"
  exit 1
fi

FILE_COUNT=$(find "$STORAGE_PATH" -type f 2>/dev/null | wc -l)
TOTAL_SIZE=$(du -sh "$STORAGE_PATH" 2>/dev/null | cut -f1)

echo "$(date -u +%FT%TZ) OK: disk=${PCT}% files=${FILE_COUNT} size=${TOTAL_SIZE} path=${STORAGE_PATH}"

if [ "$PCT" -ge "$CRIT_PCT" ]; then
  echo "$(date -u +%FT%TZ) CRITICAL: storage disk usage ${PCT}% >= ${CRIT_PCT}% — tindakan segera diperlukan (tambah disk / bersihkan orphan)"
  logger -t kahade-storage "CRITICAL: storage disk usage ${PCT}%"
  exit 1
elif [ "$PCT" -ge "$WARN_PCT" ]; then
  echo "$(date -u +%FT%TZ) WARNING: storage disk usage ${PCT}% >= ${WARN_PCT}%"
  logger -t kahade-storage "WARNING: storage disk usage ${PCT}%"
  exit 1
fi

exit 0
