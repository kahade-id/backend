# syntax=docker/dockerfile:1.7
# ============================================================================
# Kahade Backend — production Docker image
#
# Flat repository layout: this Dockerfile is built with the repository root as
# the context and npm as the package manager:
#   docker build -t kahade-api:latest .
#
# (AUDIT-4: this file previously described a pnpm workspace with an
# `apps/backend/` sub-package — paths that do not exist in this repository —
# so every `docker build`/`docker compose --build` failed immediately. There is
# no pnpm-lock.yaml here either, which makes `pnpm install --frozen-lockfile`
# unresolvable.)
# ============================================================================
ARG NODE_VERSION=20-alpine

FROM node:${NODE_VERSION} AS base
ENV NODE_ENV=production
WORKDIR /app
# python3/make/g++ are needed to build the native bcrypt/argon2 addons from
# source (no prebuilt binaries are vendored for the alpine musl target).
RUN apk add --no-cache python3 make g++ openssl

# ─── deps: install the full dependency tree once, shared by later stages ─────
FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund

# ─── builder: prisma generate + tsc build (devDependencies available) ────────
FROM deps AS builder
COPY . .
RUN npx prisma generate \
    && npm run build

# ─── prod-deps: prune to production-only dependencies ───────────────────────
FROM deps AS prod-deps
RUN npm prune --omit=dev

# ─── runtime ─────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
RUN apk add --no-cache openssl postgresql-client bash tini wget \
    && addgroup -S app -g 1001 \
    && adduser -S app -G app -u 1001
ENV NODE_ENV=production \
    PORT=3000

COPY --from=prod-deps --chown=app:app /app/node_modules ./node_modules
# Prisma client + engine artifacts produced by `prisma generate` in builder —
# node_modules/.prisma and @prisma/client resolve the query engine from here.
COPY --from=builder --chown=app:app /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=app:app /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder --chown=app:app /app/package.json ./package.json
COPY --from=builder --chown=app:app /app/prisma ./prisma
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/scripts ./scripts
COPY --from=builder --chown=app:app /app/entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh && (chmod +x scripts/*.sh 2>/dev/null || true)

USER app
EXPOSE 3000

# AUDIT: resolve the global prefix from the runtime environment — the previous
# hard-coded /v1/health broke the health check (and Docker restarts) whenever
# API_PREFIX was set to anything other than the default "v1".
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider "http://localhost:${PORT:-3000}/${API_PREFIX:-v1}/health" || exit 1

ENTRYPOINT ["/sbin/tini", "--", "./entrypoint.sh"]
