#!/bin/bash
set -e

NODE_ENV="${NODE_ENV:-production}"

echo "[entrypoint] Environment: $NODE_ENV"
echo "[entrypoint] Running Prisma migrations..."
timeout 120 ./node_modules/.bin/prisma migrate deploy || { echo "[entrypoint] Migration failed!"; exit 1; }

echo "[entrypoint] Applying database constraints..."
bash scripts/run-constraints.sh

echo "[entrypoint] Starting Kahade Backend (NODE_ENV=$NODE_ENV)..."
exec node dist/main
