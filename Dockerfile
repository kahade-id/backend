# syntax=docker/dockerfile:1.7
# ============================================================================
# Kahade Backend — production Docker image
#
# Build from the repository root:
#   docker build -f apps/backend/Dockerfile -t kahade-api:latest .
#
# The repository is a pnpm workspace. The Docker build context must therefore
# include pnpm-lock.yaml and pnpm-workspace.yaml; docker-compose.yml sets the
# corresponding root context.
# ============================================================================
ARG NODE_VERSION=20-alpine
ARG PNPM_VERSION=10.26.1

FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
WORKDIR /app
RUN apk add --no-cache python3 make g++ openssl \
    && corepack enable \
    && corepack prepare pnpm@${PNPM_VERSION} --activate

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/package.json apps/backend/package.json
RUN --mount=type=cache,id=kahade-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter kahade-backend...

FROM deps AS builder
COPY apps/backend apps/backend
RUN pnpm --filter kahade-backend exec prisma generate \
    && pnpm --filter kahade-backend run build

# The workspace is not configured for injected packages, so legacy deploy is
# explicit here. It produces a self-contained production dependency tree.
RUN pnpm deploy --legacy --filter kahade-backend --prod /prod/backend \
    && cd /prod/backend \
    && ./node_modules/.bin/prisma generate

FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
RUN apk add --no-cache openssl postgresql-client bash tini wget \
    && addgroup -S app -g 1001 \
    && adduser -S app -G app -u 1001
ENV NODE_ENV=production \
    PORT=3000

COPY --from=builder --chown=app:app /prod/backend ./
COPY --from=builder --chown=app:app /app/apps/backend/dist ./dist
COPY --from=builder --chown=app:app /app/apps/backend/scripts ./scripts
COPY --from=builder --chown=app:app /app/apps/backend/entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh scripts/*.sh 2>/dev/null || true

USER app
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--", "./entrypoint.sh"]
