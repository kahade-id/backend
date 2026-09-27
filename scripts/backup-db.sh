#!/usr/bin/env bash
#
# backup-db.sh — Backup DB harian TERENKRIPSI (SEC-306).
#
# Alur: pg_dump (format custom, kompresi zlib internal) | gpg --symmetric
#       --cipher-algo AES256 -> ${BACKUP_DIR}/kahade_prod_<ts>.dump.gpg
#
# Passphrase enkripsi TIDAK hardcoded dan TIDAK diambil dari .env aplikasi.
# Sumber passphrase (urutan prioritas):
#   1. File yang ditunjuk env KAHADE_BACKUP_PASSPHRASE_FILE (wajib chmod 600,
#      owner kahade:kahade) — dipakai via --passphrase-file (tidak muncul di
#      process list / shell history).
#   2. Env KAHADE_BACKUP_PASSPHRASE — hanya untuk pengujian manual; jangan
#      set di cron (terlihat di /proc/<pid>/environ milik user yang sama).
#
# Kredensial DB dibaca dari env KAHADE_PG_BACKUP_PASSWORD (PGPASSWORD).
#
# Jalankan sebagai user kahade. Contoh cron:
#   0 2 * * * /home/kahade/backup-db.sh >> /var/log/kahade/backup.log 2>&1
#
set -euo pipefail

BACKUP_DIR="${KAHADE_BACKUP_DIR:-/var/backups/kahade}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="${BACKUP_DIR}/kahade_prod_${TIMESTAMP}.dump.gpg"

PGHOST="${KAHADE_PGHOST:-127.0.0.1}"
PGUSER="${KAHADE_PGUSER:-kahade_prod}"
PGDATABASE="${KAHADE_PGDATABASE:-kahade_prod}"
export PGPASSWORD="${KAHADE_PG_BACKUP_PASSWORD:-}"

if [ -z "$PGPASSWORD" ]; then
  echo "ERROR: KAHADE_PG_BACKUP_PASSWORD belum di-set." >&2
  exit 2
fi

# Tentukan sumber passphrase.
GPG_PASSPHRASE_ARGS=()
if [ -n "${KAHADE_BACKUP_PASSPHRASE_FILE:-}" ]; then
  if [ ! -f "$KAHADE_BACKUP_PASSPHRASE_FILE" ]; then
    echo "ERROR: passphrase file tidak ditemukan: $KAHADE_BACKUP_PASSPHRASE_FILE" >&2
    exit 2
  fi
  # Pastikan tidak terbaca pihak lain (SEC-306: kunci terpisah dari backup).
  perms="$(stat -c '%a %u %g' "$KAHADE_BACKUP_PASSPHRASE_FILE")"
  case "$perms" in
    600\ *) ;; # ok
    *) echo "ERROR: passphrase file harus chmod 600 (sekarang: $perms)." >&2; exit 2 ;;
  esac
  GPG_PASSPHRASE_ARGS=(--passphrase-file "$KAHADE_BACKUP_PASSPHRASE_FILE")
elif [ -n "${KAHADE_BACKUP_PASSPHRASE:-}" ]; then
  echo "WARNING: memakai passphrase dari env (hanya untuk pengujian manual)." >&2
  GPG_PASSPHRASE_ARGS=(--passphrase "$KAHADE_BACKUP_PASSPHRASE")
else
  echo "ERROR: set KAHADE_BACKUP_PASSPHRASE_FILE (disarankan) atau KAHADE_BACKUP_PASSPHRASE." >&2
  exit 2
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

pg_dump -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" \
  --no-owner --no-privileges --format=custom \
  | gpg --batch --yes --pinentry-mode loopback \
      --symmetric --cipher-algo AES256 \
      "${GPG_PASSPHRASE_ARGS[@]}" \
      -o "$BACKUP_FILE"

chmod 600 "$BACKUP_FILE"

# Verifikasi cepat: header GPG valid & bisa didekripsi (tanpa menulis plaintext ke disk).
gpg --batch --quiet --pinentry-mode loopback \
  "${GPG_PASSPHRASE_ARGS[@]}" \
  --decrypt "$BACKUP_FILE" 2>/dev/null \
  | pg_restore --list - >/dev/null

# Retensi: serahkan ke backup-retention.sh bila ada, fallback pola lama.
if [ -x "$(dirname "$0")/backup-retention.sh" ]; then
  KAHADE_BACKUP_DIR="$BACKUP_DIR" "$(dirname "$0")/backup-retention.sh" >/dev/null
else
  find "$BACKUP_DIR" -maxdepth 1 -name 'kahade_prod_*.dump.gpg' -mtime +14 -delete
fi

echo "[$(date '+%F %T')] Backup terenkripsi: ${BACKUP_FILE} ($(du -h "$BACKUP_FILE" | cut -f1))"
