#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="${KAHADE_BACKUP_DIR:-/var/backups/kahade}"
KEEP_DB="${KAHADE_KEEP_DB_BACKUPS:-14}"
KEEP_DIST="${KAHADE_KEEP_DIST_BACKUPS:-5}"
KEEP_SCHEMA="${KAHADE_KEEP_SCHEMA_BACKUPS:-14}"

case "$KEEP_DB:$KEEP_DIST:$KEEP_SCHEMA" in
  *[!0-9:]*|0:*|*:0:*|*:*:0) echo 'Retention values must be positive integers' >&2; exit 2;;
esac

[ -d "$BACKUP_DIR" ] || { echo "Backup directory not found: $BACKUP_DIR" >&2; exit 1; }

mapfile -t db_files < <(find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'db-*.sql.gz' -o -name 'kahade_prod_*.dump' -o -name 'kahade_prod_*.dump.gpg' \) -printf '%T@ %p\n' | sort -nr | cut -d' ' -f2-)
if [ "${#db_files[@]}" -eq 0 ]; then
  echo 'No database backup found; refusing cleanup.' >&2
  exit 1
fi

latest_db="${db_files[0]}"
case "$latest_db" in
  *.sql.gz) gzip -t -- "$latest_db" ;;
  *.dump) pg_restore --list -- "$latest_db" >/dev/null ;;
  *.dump.gpg)
    # SEC-306: backup terenkripsi — validasi dengan dekripsi ke temp file 600
    # lalu shred (pg_restore 18 butuh file seekable, tidak bisa baca dari pipe).
    # Butuh KAHADE_BACKUP_PASSPHRASE_FILE.
    if [ -n "${KAHADE_BACKUP_PASSPHRASE_FILE:-}" ] && [ -f "$KAHADE_BACKUP_PASSPHRASE_FILE" ]; then
      tmp_verify="$(mktemp /tmp/kahade-retention-verify-XXXXXX.dump)"
      chmod 600 "$tmp_verify"
      gpg --batch --quiet --pinentry-mode loopback \
        --passphrase-file "$KAHADE_BACKUP_PASSPHRASE_FILE" \
        --decrypt -- "$latest_db" 2>/dev/null > "$tmp_verify"
      pg_restore --list -- "$tmp_verify" >/dev/null
      shred -u "$tmp_verify"
    else
      echo 'WARNING: passphrase file tidak tersedia — lewati validasi integritas backup terenkripsi.' >&2
    fi
    ;;
  *) echo "Unsupported database backup format: $latest_db" >&2; exit 1 ;;
esac

purge_db_files() {
  if [ "${#db_files[@]}" -gt "$KEEP_DB" ]; then
    for file in "${db_files[@]:$KEEP_DB}"; do
      rm -f -- "$file"
    done
  fi
}

purge_files() {
  local pattern="$1" keep="$2"
  mapfile -t files < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name "$pattern" -printf '%T@ %p\n' | sort -nr | cut -d' ' -f2-)
  if [ "${#files[@]}" -gt "$keep" ]; then
    for file in "${files[@]:$keep}"; do
      rm -f -- "$file"
    done
  fi
}

purge_dirs() {
  local pattern="$1" keep="$2"
  mapfile -t dirs < <(find "$BACKUP_DIR" -maxdepth 1 -type d -name "$pattern" -printf '%T@ %p\n' | sort -nr | cut -d' ' -f2-)
  if [ "${#dirs[@]}" -gt "$keep" ]; then
    for dir in "${dirs[@]:$keep}"; do
      rm -rf -- "$dir"
    done
  fi
}

purge_db_files
purge_files 'schema-*.prisma' "$KEEP_SCHEMA"
purge_dirs 'dist-pre-*' "$KEEP_DIST"

echo "Backup retention complete: db=$KEEP_DB dist=$KEEP_DIST schema=$KEEP_SCHEMA latest_db=$latest_db"
