#!/bin/bash
set -e

NODE_ENV="${NODE_ENV:-development}"

if [ "$NODE_ENV" = "production" ]; then
  echo "ERROR: start.sh is for development only. Use entrypoint.sh for production."
  exit 1
fi

if [ -z "$REDIS_PASSWORD" ]; then
  echo "ERROR: REDIS_PASSWORD must be set"
  exit 1
fi

redis-server --daemonize yes --port 6379 --loglevel warning --requirepass "$REDIS_PASSWORD"

echo "Redis started"

MIGRATION_LOCK_ID=202603211
DATABASE_URL_FOR_LOCK="${DATABASE_URL}"

acquire_migration_lock() {
  psql "$DATABASE_URL_FOR_LOCK" -c "SELECT pg_advisory_lock($MIGRATION_LOCK_ID);" 2>/dev/null || true
}

release_migration_lock() {
  psql "$DATABASE_URL_FOR_LOCK" -c "SELECT pg_advisory_unlock($MIGRATION_LOCK_ID);" 2>/dev/null || true
}

acquire_migration_lock
trap release_migration_lock EXIT

timeout 120 npx prisma migrate deploy || { echo "Migration failed"; exit 1; }

release_migration_lock
trap - EXIT

echo "Database migrated"

if [ "$NODE_ENV" = "staging" ]; then
  echo "Starting in staging mode..."
  exec node dist/main
else
  echo "Starting in development mode..."
  exec npm run start:dev
fi
