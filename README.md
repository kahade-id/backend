# Kahade Backend

NestJS 11 + Prisma 5 + PostgreSQL 16 + Redis 7 — the API and background-worker
for Kahade, a P2P escrow platform for Indonesia (PT Kawal Hak Dengan Aman).

> **For full production deployment, see [`DEPLOYMENT_GUIDE.md`](./DEPLOYMENT_GUIDE.md).**
> This README is the 5-minute "get running locally" guide.

## Quick start (local)

```bash
# 1. Install deps (from the monorepo root)
cd ../..
pnpm install --frozen-lockfile
cd apps/backend

# 2. Configure env
cp .env.example .env
# edit .env — at minimum set:
#   - DATABASE_URL (a local Postgres 16+)
#   - REDIS_URL, BULL_REDIS_URL (a local Redis 7+)
#   - JWT_*_SECRET, AES_SECRET_KEY, HMAC_SECRET_KEY, AES_KDF_SALT, WALLET_PIN_PEPPER
#     → generate with `openssl rand -hex 32` / `openssl rand -hex 16`

# 3. Database
npm run prisma:generate
npm run prisma:migrate              # applies all migrations
npm run prisma:seed                 # optional: dev users (NEVER in production)

# 4. Run
npm run start:dev                   # nest start --watch
# API:        http://localhost:3000/v1
# Swagger:    http://localhost:3000/docs (dev only)
# Health:     http://localhost:3000/v1/health
```

## Running with Docker

`docker-compose.yml` boots the full stack (Nginx + API + Postgres + main Redis +
Bull Redis):

```bash
cp .env.example .env
# fill the secrets used by docker-compose: POSTGRES_PASSWORD, REDIS_PASSWORD,
# plus all the JWT/crypto secrets.

docker compose up -d --build
docker compose logs -f api
```

## Project structure

```
src/
├── main.ts                 # bootstrap (CORS, helmet, secret validation, Sentry, Swagger)
├── instrument.ts           # Sentry init (PII redaction)
├── app.module.ts           # global guards/interceptors/filters wiring
├── common/                 # guards, decorators, filters, services, utils, dto
├── config/                 # env.validation.ts (startup validation)
├── prisma/                 # PrismaService (extensions, slow-query log, request-id)
├── redis/                  # RedisService
└── modules/
    ├── auth/               # login, refresh, register, 2FA, OTP
    ├── users/              # profile, follows, blocks
    ├── orders/             # P2P escrow lifecycle + state machine
    ├── wallet/             # balance, transfer, topup, withdraw, PIN
    ├── disputes/           # dispute resolution + admin handling
    ├── chat/               # chat rooms, messages, reactions, attachments
    ├── kyc/                # NIK + KTP + selfie capture & verification
    ├── notifications/      # in-app + push (FCM)
    ├── payments/           # Midtrans integration + webhook handler
    ├── upload/             # presigned R2 uploads
    ├── admin/              # operator console endpoints (treasury, KYC review)
    └── …                   # ~24 feature modules
prisma/
├── schema.prisma           # 58 models, 45 enums
└── migrations/             # 37 migrations (kept in source control)
test/
└── critical-flows.e2e-spec.ts
```

## Common scripts

| Command | What it does |
|---|---|
| `npm run start:dev` | Nest watch mode (HMR). |
| `npm run build` | `nest build` → `dist/`. |
| `npm run start` | `node dist/main` (production runtime). |
| `npm run lint` | ESLint over `src/` and `test/`. |
| `npm run test` | Jest unit tests (`src/**/*.spec.ts`). |
| `npm run test:cov` | Jest with coverage (threshold 70% on whitelisted files). |
| `npm run test:e2e` | E2E tests in `test/`. |
| `npm run prisma:migrate` | Apply pending migrations + run constraints script. |
| `npm run prisma:generate` | Regenerate Prisma client (after schema edits). |
| `npm run prisma:seed` | Seed dev data (refuses to run in production). |
| `npm run db:constraints` | Apply DB-level CHECK / partial-index constraints. |
| `npm run openapi:generate` | Boot the Nest app (no HTTP server) and dump Swagger spec to `openapi.json`. Frontends consume this to generate typed SDKs. Requires Postgres + Redis to be reachable (see `docker-compose.yml`). |
| `npm run format` | Prettier. |

## Configuration

All env vars are validated at startup by [`src/config/env.validation.ts`](./src/config/env.validation.ts).
Missing or malformed vars throw a single error message listing every problem so
you don't fix them one at a time. See [`.env.example`](./.env.example) for the
full template.

Key invariants enforced:

- `JWT_*_SECRET` ≥ 32 chars
- `AES_SECRET_KEY` / `HMAC_SECRET_KEY` ≥ 64 hex chars
- `WALLET_PIN_PEPPER` ≥ 32 chars
- `OTP_PROVIDER=mock` is **rejected** in production (real provider required)
- `MIDTRANS_ALLOWED_CIDRS` required in production/staging

## Security architecture (high level)

- **Secrets:** strict validation at boot (above). PII (phone, NIK) encrypted
  at rest with AES-GCM; lookup uses argon2id hash side-table.
- **Auth:** stateless JWT (short-lived access + long-lived refresh in HTTP-only
  cookie), separate admin token chain, optional TOTP 2FA + backup codes.
- **Wallet PIN:** HMAC-pepper → bcrypt double-hash to resist offline cracking.
- **CSRF:** required for cookie-authenticated state-changing requests. Bearer-token
  callers (mobile / admin native) skip CSRF per OWASP guidance.
- **Rate limiting:** `@nestjs/throttler` global + per-route knobs (auth/OTP/PIN).
- **Webhooks:** Midtrans signature verified + IP/CIDR allow-list.
- **DB:** statement timeout 30s, slow-query log >1s, advisory-locked migrations,
  Prisma `Serializable` isolation for wallet-mutating transactions.
- **Storage:** R2 presigned uploads with magic-byte verification before commit.
- **Observability:** Sentry with PII redaction; Winston structured logs;
  request-id propagation through `AsyncLocalStorage`.

## Contributing

1. Create a feature branch off `main`.
2. Run `npm run lint` and `npm run test` before pushing.
3. Open a PR — CI runs lint + build + test with coverage.
4. The team uses **conventional commits** (`feat:`, `fix:`, `chore:`, …).

> The `kahade-id/backend` GitHub repo is published from a private monorepo via
> [`scripts/release.sh`](../mobile/scripts/release.sh) in the mobile repo. PRs
> opened directly against this mirror are reviewed and back-ported.

## License

UNLICENSED — proprietary code of PT Kawal Hak Dengan Aman.
