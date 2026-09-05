#!/usr/bin/env bash
set -euo pipefail

# Use a dedicated admin connection explicitly. Do not derive a verification
# target from the application DATABASE_URL by default: that can accidentally
# create/drop a temporary database on the production application server.
ADMIN_URL="${KAHADE_VERIFY_ADMIN_URL:-}"
BACKUP_FILE="${1:-}"

if [ -z "$ADMIN_URL" ]; then
  echo "ERROR: KAHADE_VERIFY_ADMIN_URL is required and must target a non-production verification server/database." >&2
  exit 1
fi

if [ -z "$BACKUP_FILE" ]; then
  echo "Usage: KAHADE_VERIFY_ADMIN_URL='<admin connection URL>' $0 <backup_file>" >&2
  echo "Verifies a database backup by restoring to a temporary database and running integrity checks." >&2
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "ERROR: Backup file not found: $BACKUP_FILE" >&2
  exit 1
fi

case "$BACKUP_FILE" in
  *.sql.gz|*.dump|*.sql) ;;
  *) echo "ERROR: Unsupported backup format; expected .sql.gz, .dump, or .sql: $BACKUP_FILE" >&2; exit 1 ;;
esac

# Milliseconds plus a cryptographically random suffix prevent collisions when
# multiple verification jobs run concurrently on the same PostgreSQL server.
VERIFY_DB="kahade_backup_verify_$(date +%s%N)_$(openssl rand -hex 6)"
# PostgreSQL identifiers are limited to 63 bytes; this generated value is well
# below the limit and contains only safe identifier characters.
echo "[verify-backup] Creating temporary database: $VERIFY_DB"

BASE_URL="${ADMIN_URL%%\?*}"
BASE_URL="${BASE_URL%/*}"
VERIFY_URL="${BASE_URL}/${VERIFY_DB}"

psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$VERIFY_DB\";"

cleanup() {
  echo "[verify-backup] Dropping temporary database: $VERIFY_DB"
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$VERIFY_DB\";" >/dev/null || true
}
trap cleanup EXIT

restore_sql() {
  if [[ "$BACKUP_FILE" == *.sql.gz ]]; then
    gzip -t -- "$BACKUP_FILE"
    gunzip -c -- "$BACKUP_FILE" | psql "$VERIFY_URL" --quiet -v ON_ERROR_STOP=1
  elif [[ "$BACKUP_FILE" == *.dump ]]; then
    pg_restore --exit-on-error --no-owner --no-privileges --dbname="$VERIFY_URL" -- "$BACKUP_FILE"
  else
    psql "$VERIFY_URL" --quiet -v ON_ERROR_STOP=1 < "$BACKUP_FILE"
  fi
}

echo "[verify-backup] Restoring backup to temporary database..."
restore_sql

echo "[verify-backup] Running integrity checks..."

TABLES="$(psql "$VERIFY_URL" -v ON_ERROR_STOP=1 -At -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';")"
if ! [[ "$TABLES" =~ ^[0-9]+$ ]] || [ "$TABLES" -lt 10 ]; then
  echo "ERROR: Only $TABLES tables found in backup — expected at least 10." >&2
  exit 1
fi

CRITICAL_TABLES=("users" "wallets" "orders" "wallet_transactions" "notifications")
for tbl in "${CRITICAL_TABLES[@]}"; do
  COUNT="$(psql "$VERIFY_URL" -v ON_ERROR_STOP=1 -At -c "SELECT count(*) FROM \"$tbl\";")"
  if ! [[ "$COUNT" =~ ^[0-9]+$ ]]; then
    echo "ERROR: Critical table '$tbl' returned an invalid count: $COUNT" >&2
    exit 1
  fi
  echo "  $tbl: $COUNT rows"
done

CONSTRAINTS="$(psql "$VERIFY_URL" -v ON_ERROR_STOP=1 -At -c "SELECT count(*) FROM information_schema.table_constraints WHERE constraint_schema = 'public';")"
if ! [[ "$CONSTRAINTS" =~ ^[0-9]+$ ]]; then
  echo "ERROR: Invalid constraint count: $CONSTRAINTS" >&2
  exit 1
fi
echo "  Constraints: $CONSTRAINTS"

echo "[verify-backup] Backup verification PASSED ($TABLES tables, $CONSTRAINTS constraints)."
echo "[verify-backup] Backup file: $BACKUP_FILE"
echo "[verify-backup] Verified at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
