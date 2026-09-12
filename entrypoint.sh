#!/bin/bash
set -e

NODE_ENV="${NODE_ENV:-production}"

echo "[entrypoint] Environment: $NODE_ENV"

# AUDIT-5: with multiple replicas (compose scale / k8s rolling restart / PM2), every
# container used to race `prisma migrate deploy` + `run-constraints.sh` against the
# same schema with no coordination — start.sh already serialises the same work with a
# Postgres advisory lock; the production entrypoint now does the same. The lock is
# released automatically when the session ends, so a crash mid-migration cannot wedge
# the fleet forever; the acquire below waits (bounded) instead of failing instantly.
MIGRATION_LOCK_ID=202603211
if [ -n "$DATABASE_URL" ]; then
  echo "[entrypoint] Acquiring migration advisory lock..."
  timeout 300 psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "SELECT pg_advisory_lock($MIGRATION_LOCK_ID);" \
    || echo "[entrypoint] WARNING: could not take advisory lock via psql; continuing without it"
fi

echo "[entrypoint] Running Prisma migrations..."
timeout 120 ./node_modules/.bin/prisma migrate deploy || { echo "[entrypoint] Migration failed!"; exit 1; }

echo "[entrypoint] Applying database constraints..."
bash scripts/run-constraints.sh

# Release the advisory lock (best effort; session teardown releases it anyway).
if [ -n "$DATABASE_URL" ]; then
  timeout 30 psql "$DATABASE_URL" -c "SELECT pg_advisory_unlock($MIGRATION_LOCK_ID);" >/dev/null 2>&1 || true
fi

echo "[entrypoint] Starting Kahade Backend (NODE_ENV=$NODE_ENV)..."
exec node dist/main
