# Kahade Backend — Production Deployment Guide

**Target:** Ubuntu 24.04 LTS (fresh VPS / dedicated server)
**Stack:** NestJS 11 + Prisma + PostgreSQL 16 + Redis 7 + Nginx + PM2 + Certbot
**Entry Point:** `node dist/main` on port 3000
**Package Manager:** pnpm 10.26.1 (monorepo workspace — `npm ci` tidak bekerja)
**Last Updated:** August 2026 (rev 6 — prosedur kanonis tunggal)

> **Dokumen kanonis tunggal.** Gunakan panduan ini untuk instalasi, rilis,
> smoke read-only, cutover, dan rollback. Jangan membuat runbook deployment
> kedua atau file environment kedua.

> **Pola produksi legacy yang dipertahankan.** Semua secret tetap berada pada
> `/var/www/kahade/apps/backend/.env`; file tersebut tidak pernah disalin ke
> checkout release atau Git. Source rilis bersifat immutable di
> `/var/www/kahade-release-<SHA>`, sementara PM2 selalu menjalankan symlink
> `/var/www/kahade-current/apps/backend` melalui satu konfigurasi
> `/etc/kahade/kahade-api.config.cjs`.

> **Rev 4 — apa yang berubah.** Guide ini diverifikasi ulang baris-per-baris
> terhadap source code, bukan hanya dibaca. Perbaikan yang memblokir deploy:
> perintah install `npm ci` → `pnpm` (repo ini workspace pnpm tanpa
> `package-lock.json`), `WALLET_PIN_PEPPER` dan `OTP_PROVIDER` yang wajib tapi
> tidak ada di template `.env`, `AES_KDF_SALT` yang di-generate terlalu pendek
> (44 karakter, minimumnya 64), path aplikasi, jumlah cron scheduler (8 → 21),
> dan script auto-restart yang akan me-restart API tiap 2 menit saat SMTP down.
> Template `.env` di Section 6.3 sudah diuji lolos seluruh validasi startup.

---

## Table of Contents

1. [Prerequisites & Architecture](#1-prerequisites--architecture)
2. [Server Initial Setup](#2-server-initial-setup)
3. [Install System Dependencies](#3-install-system-dependencies)
4. [PostgreSQL Setup](#4-postgresql-setup)
5. [Redis Setup](#5-redis-setup)
6. [Application Deployment](#6-application-deployment)
7. [PM2 Process Manager](#7-pm2-process-manager)
8. [Nginx Reverse Proxy](#8-nginx-reverse-proxy)
9. [SSL with Let's Encrypt](#9-ssl-with-lets-encrypt)
10. [Security Hardening](#10-security-hardening)
11. [Monitoring & Health Checks](#11-monitoring--health-checks)
12. [Database Backup](#12-database-backup)
13. [Deploy Update Script](#13-deploy-update-script)
14. [Docker Deployment (Alternative)](#14-docker-deployment-alternative)
15. [Client Apps (Expo / EAS)](#15-client-apps-expo--eas)
16. [Production Considerations](#16-production-considerations)
17. [FCM Push Notifications (Optional)](#17-fcm-push-notifications-optional)
18. [Staging Environment](#18-staging-environment)
19. [Troubleshooting](#19-troubleshooting)
20. [Quick Reference Cheatsheet](#20-quick-reference-cheatsheet)

---

## 1. Prerequisites & Architecture

### 1.1 Architecture Overview

```
                    ┌──────────────────────────────────────────┐
                    │              Ubuntu 24.04 VPS             │
                    │                                          │
  Internet ──────► │  Nginx (443/80)                           │
                    │    ├─► NestJS API (:3000) ◄──► PostgreSQL │
                    │    │        ▲                              │
                    │    │        └──── Redis (:6379)            │
                    │    │                                       │
                    │    └─► /v1/health (probe)                 │
                    └──────────────────────────────────────────┘

  EC2/VPS  ──► api.kahade.id      (NestJS backend — satu-satunya yang di-deploy ke server)
  EAS Build ─► Kahade (mobile)    Expo app, APK/AAB/IPA → id.kahade.app
  EAS Build ─► Kahade Admin       Expo app, APK/AAB/IPA → id.kahade.admin
```

Hanya backend yang di-deploy ke server. Kedua client adalah aplikasi Expo
(React Native) yang di-build via EAS dan didistribusikan sebagai binary —
lihat Section 15.

### 1.2 Minimum Server Requirements

| Traffic Level | vCPU | RAM   | Disk   | PM2 Instances |
|:--------------|:-----|:------|:-------|:--------------|
| Low (< 1K users)   | 1 | 2 GB  | 40 GB  | 1 |
| Medium (1K–10K)     | 2 | 4 GB  | 80 GB  | 2 |
| High (10K–50K)      | 4 | 8 GB  | 160 GB | 4 |
| Scale (50K+)        | 8+ | 16 GB+ | 320 GB+ | max |

### 1.3 Domain & DNS

Before starting, point your DNS records:

| Record | Name | Value |
|:-------|:-----|:------|
| A | `api.kahade.id` | Your VPS IP |

`api.kahade.id` adalah satu-satunya record yang wajib. Client mobile & admin
adalah app Expo native yang memanggil host itu langsung — tidak butuh DNS
sendiri. Tambahkan `admin.kahade.id` hanya jika nanti benar-benar meng-host
admin sebagai web build (`expo export --platform web`).

---

## 2. Server Initial Setup

### 2.1 System Update

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl wget git build-essential software-properties-common jq
```

### 2.2 Create Application User

```bash
sudo adduser --disabled-password --gecos "Kahade App" kahade
sudo usermod -aG sudo kahade

echo "kahade ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart nginx, /usr/bin/systemctl reload nginx" \
  | sudo tee /etc/sudoers.d/kahade
```

### 2.3 Configure UFW Firewall

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

### 2.4 Set Timezone

```bash
sudo timedatectl set-timezone Asia/Jakarta
timedatectl
```

> **Penting:** Timezone `Asia/Jakarta` wajib karena order ID generation dan semua cron scheduler menggunakan WIB.

---

## 3. Install System Dependencies

### 3.1 Node.js 20 LTS (via NVM)

```bash
sudo su - kahade

curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc

nvm install 20
nvm alias default 20
nvm use default

node -v   # v20.x.x
npm -v    # v10.x.x
```

### 3.2 pnpm (package manager repo ini)

Repo ini adalah **pnpm workspace** (`packageManager: pnpm@10.26.1`). `npm ci`
tidak akan bekerja — tidak ada `package-lock.json`. Aktifkan pnpm lewat corepack
yang sudah dibundel Node 20:

```bash
corepack enable
corepack prepare pnpm@10.26.1 --activate

pnpm -v   # 10.26.1
```

> Versi harus cocok dengan field `packageManager` di `package.json` root supaya
> resolusi lockfile identik dengan mesin developer dan CI.

### 3.3 PM2

```bash
npm install -g pm2
pm2 --version
```

### 3.4 PostgreSQL 16

```bash
exit  # kembali ke root/sudo user

sudo apt install -y postgresql-16 postgresql-client-16
sudo systemctl enable postgresql
sudo systemctl start postgresql
sudo systemctl status postgresql
```

### 3.5 Redis 7

```bash
sudo apt install -y redis-server
sudo systemctl enable redis-server
```

### 3.6 Nginx

```bash
sudo apt install -y nginx
sudo systemctl enable nginx
sudo systemctl start nginx
```

### 3.7 Certbot

```bash
sudo apt install -y certbot python3-certbot-nginx
```

---

## 4. PostgreSQL Setup

### 4.1 Create Production Database & User

```bash
sudo -u postgres psql
```

```sql
-- Buat user production (ganti password!)
CREATE USER kahade_prod WITH PASSWORD 'GANTI_DENGAN_PASSWORD_KUAT';

-- Buat database
CREATE DATABASE kahade_prod OWNER kahade_prod;

-- Set privileges
\c kahade_prod
GRANT CONNECT ON DATABASE kahade_prod TO kahade_prod;
GRANT USAGE ON SCHEMA public TO kahade_prod;
GRANT CREATE ON SCHEMA public TO kahade_prod;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kahade_prod;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO kahade_prod;

\q
```

### 4.2 Configure Authentication

```bash
sudo nano /etc/postgresql/16/main/pg_hba.conf
```

Pastikan baris ini ada:

```
local   kahade_prod   kahade_prod                         scram-sha-256
host    kahade_prod   kahade_prod   127.0.0.1/32          scram-sha-256
```

### 4.3 PostgreSQL Tuning (Production)

```bash
sudo nano /etc/postgresql/16/main/postgresql.conf
```

Sesuaikan berdasarkan RAM server:

```conf
# Connections
listen_addresses = 'localhost'
max_connections = 100

# Memory (contoh untuk 4 GB RAM)
shared_buffers = 1GB
effective_cache_size = 3GB
work_mem = 16MB
maintenance_work_mem = 256MB

# WAL
wal_buffers = 64MB
checkpoint_completion_target = 0.9
max_wal_size = 2GB

# Logging
log_min_duration_statement = 1000   # log query > 1 detik
log_line_prefix = '%m [%p] %u@%d '
```

```bash
sudo systemctl restart postgresql
```

### 4.4 Test Connection

```bash
psql -U kahade_prod -d kahade_prod -h 127.0.0.1 -W
# Masukkan password, lalu \q untuk keluar
```

---

## 5. Redis Setup

### 5.1 Configure Redis for Production

```bash
sudo nano /etc/redis/redis.conf
```

Ubah/tambahkan:

```conf
# Bind localhost only
bind 127.0.0.1 ::1

# Password (generate yang kuat!)
requirepass GANTI_DENGAN_PASSWORD_REDIS_KUAT

# Disable dangerous commands
rename-command FLUSHDB ""
rename-command FLUSHALL ""
rename-command CONFIG "KAHADE_CONFIG_b7f3a9e2"

# Memory (sesuaikan RAM server)
maxmemory 512mb
# CRITICAL: Harus noeviction — JANGAN gunakan allkeys-lru!
# JWT blacklist dan session revocation keys tidak boleh di-evict.
# Jika memory penuh, Redis akan menolak write daripada evict security keys.
maxmemory-policy noeviction

# Persistence
appendonly yes
appendfsync everysec
```

### 5.2 Restart & Test

```bash
sudo systemctl restart redis-server

redis-cli -a PASSWORD_REDIS ping
# Output: PONG
```

---

## 6. Application Deployment

### 6.1 Clone Repository

> **Ini monorepo pnpm.** Backend tinggal di `apps/backend` di dalam repo
> `kahade-id/kahade` — tidak ada repo `kahade-backend` terpisah. Dependency
> di-hoist ke `node_modules` root lewat pnpm workspace, jadi **install harus
> dijalankan dari root repo**, bukan dari `apps/backend`. Repo juga tidak punya
> `package-lock.json`, jadi `npm ci` akan gagal.

```bash
sudo mkdir -p /var/www/kahade
sudo chown kahade:kahade /var/www/kahade

sudo su - kahade
git clone git@github.com:kahade-id/kahade.git /var/www/kahade
cd /var/www/kahade
```

Seluruh guide ini memakai dua path:

| Variabel | Nilai | Keterangan |
|:--|:--|:--|
| Root repo | `/var/www/kahade` | tempat `pnpm install` dijalankan |
| App backend | `/var/www/kahade/apps/backend` | tempat `.env`, build, dan PM2 dijalankan |

### 6.2 Install Dependencies

```bash
# pnpm sesuai packageManager di package.json root
corepack enable
corepack prepare pnpm@10.26.1 --activate

# Dari ROOT repo — install workspace + build native deps (argon2, bcrypt)
cd /var/www/kahade
pnpm install --frozen-lockfile --prod=false

# Prisma client
cd apps/backend
pnpm exec prisma generate
```

> `--frozen-lockfile` memastikan deploy gagal-cepat kalau `pnpm-lock.yaml`
> tertinggal dari `package.json`, bukan diam-diam menginstal versi lain.
>
> `--prod=false` diperlukan karena build butuh devDependencies (`@nestjs/cli`,
> `typescript`, `prisma`). Setelah `pnpm run build` selesai, kalau mau memangkas
> image bisa jalankan `pnpm prune --prod` — tapi untuk deploy PM2 biasa,
> biarkan saja; devDependencies tidak ikut ter-load saat runtime.

### 6.3 Create Production .env

```bash
nano /var/www/kahade/apps/backend/.env
```

**PENTING:** Setiap secret harus unik. Jangan gunakan value yang sama untuk key berbeda.

```env
# ============================================================
# KAHADE BACKEND — Production Environment
# ============================================================

# ─── App ─────────────────────────────────────────────────────
NODE_ENV=production
PORT=3000
API_PREFIX=v1
APP_VERSION=1.0.0
LOG_LEVEL=info
APP_URL=https://api.kahade.id

# ─── Database ────────────────────────────────────────────────
# Format: postgresql://USER:PASSWORD@HOST:PORT/DBNAME?connection_limit=N
DATABASE_URL=postgresql://kahade_prod:PASSWORD_DB@127.0.0.1:5432/kahade_prod?connection_limit=20&pool_timeout=10

# ─── Redis ───────────────────────────────────────────────────
# Password harus sama dengan yang di /etc/redis/redis.conf
REDIS_PASSWORD=PASSWORD_REDIS
REDIS_URL=redis://:PASSWORD_REDIS@127.0.0.1:6379
BULL_REDIS_URL=redis://:PASSWORD_REDIS@127.0.0.1:6379
REDIS_PREFIX=kahade:prod:

# ─── Trust Proxy [WAJIB di production] ───────────────────────
# CIDR load balancer/Nginx. Untuk single Nginx di localhost:
TRUSTED_PROXY_CIDR=127.0.0.1/32

# ─── JWT Secrets [WAJIB] ────────────────────────────────────
# Generate masing-masing dengan: openssl rand -hex 32
# Setiap key HARUS value unik — JANGAN reuse!
JWT_SECRET=
JWT_REFRESH_SECRET=
JWT_ADMIN_SECRET=
JWT_ADMIN_REFRESH_SECRET=
JWT_TEMP_SECRET=

JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
JWT_ADMIN_EXPIRES_IN=30m
JWT_ADMIN_REFRESH_EXPIRES_IN=7d
JWT_TEMP_EXPIRES_IN=5m

# ─── Crypto [WAJIB] ─────────────────────────────────────────
# openssl rand -hex 32   → 64 karakter
AES_SECRET_KEY=
HMAC_SECRET_KEY=
# JANGAN pakai `-base64 32` di sini — hasilnya cuma 44 karakter dan
# startup akan ditolak (minimum 64). Pakai hex:
# openssl rand -hex 32
AES_KDF_SALT=

# ─── Midtrans ───────────────────────────────────────────────
# Dari Midtrans Dashboard → Settings → Access Keys
MIDTRANS_SERVER_KEY=
MIDTRANS_CLIENT_KEY=
MIDTRANS_IS_PRODUCTION=true
MIDTRANS_IRIS_KEY=
MIDTRANS_IRIS_IS_PRODUCTION=true
MIDTRANS_NOTIFICATION_URL=https://api.kahade.id/v1/payments/midtrans-webhook
MIDTRANS_ALLOWED_CIDRS=103.208.23.0/24,103.208.24.0/24

# ─── Cloudflare R2 (S3-compatible storage) ───────────────────
# Untuk KYC documents, avatars, chat attachments
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_ACCOUNT_ID=your_cloudflare_account_id
R2_BUCKET_PUBLIC=kahade-uploads-public-prod
R2_BUCKET_PRIVATE=kahade-uploads-private-prod
R2_PUBLIC_URL=https://cdn.kahade.id

# ─── SMTP (Email) ───────────────────────────────────────────
SMTP_HOST=smtp.your-provider.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=noreply@kahade.id
SMTP_PASS=
SMTP_FROM=Kahade <noreply@kahade.id>

# ─── CORS ────────────────────────────────────────────────────
# Hanya untuk klien browser (Swagger UI, expo web). App Expo native tidak
# mengirim Origin. JANGAN ada localhost di production, jangan pakai "*".
CORS_ORIGINS=https://kahade.id,https://www.kahade.id,https://admin.kahade.id

# ─── Throttle ───────────────────────────────────────────────
THROTTLE_GLOBAL_TTL_MS=60000
THROTTLE_GLOBAL_LIMIT=100

# ─── Idempotency ────────────────────────────────────────────
# IMPORTANT: false = fail-closed (recommended for production).
# When Redis is down, financial endpoints return 503 instead of
# silently skipping idempotency checks.
IDEMPOTENCY_FAIL_OPEN=false
IDEMPOTENCY_TTL_SECONDS=86400

# ─── Order Limits ───────────────────────────────────────────
ORDER_MIN_VALUE=10000
ORDER_MAX_VALUE=1000000000

# ─── Wallet ────────────────────────────────────────────────
WALLET_DAILY_TOPUP_LIMIT=50000000
WALLET_DAILY_WITHDRAW_LIMIT=50000000
WALLET_MIN_WITHDRAW=50000
TOPUP_EXPIRY_HOURS=24
# Pepper untuk PIN wallet: bcrypt( base64( HMAC-SHA256(pepper, pin) ) ).
# WAJIB di production — env validation menolak start kalau kosong.
# Generate with: openssl rand -hex 32   (menghasilkan 64 karakter — minimumnya 64)
# CRITICAL: Once set, DO NOT change — all existing PINs become invalid!
WALLET_PIN_PEPPER=GENERATE_WITH_OPENSSL_RAND_HEX_32

# ─── Subscription Pricing ───────────────────────────────────
SUBSCRIPTION_MONTHLY_PRICE=29000
SUBSCRIPTION_ANNUAL_PRICE=299000
SUBSCRIPTION_MONTHLY_PRICE_SEN=2900000
SUBSCRIPTION_ANNUAL_PRICE_SEN=29900000

# ─── Account Security ───────────────────────────────────────
ACCOUNT_LOCK_MAX_ATTEMPTS=5
ACCOUNT_LOCK_DURATION_MINUTES=30

# ─── OTP ─────────────────────────────────────────────────────
# OTP_PROVIDER [WAJIB di production]
# Default-nya "mock" — dan startup akan DITOLAK di production kalau masih mock,
# karena user tidak akan pernah menerima OTP. Pilih "fonnte" atau "twilio".
OTP_PROVIDER=fonnte

# Kalau OTP_PROVIDER=fonnte — token wajib diisi:
FONNTE_API_TOKEN=

# Kalau OTP_PROVIDER=twilio — pakai ini sebagai gantinya (minimal salah satu
# dari TWILIO_SMS_FROM / TWILIO_WHATSAPP_FROM harus diisi):
# TWILIO_ACCOUNT_SID=
# TWILIO_AUTH_TOKEN=
# TWILIO_SMS_FROM=
# TWILIO_WHATSAPP_FROM=

# JANGAN diaktifkan di production — akan membocorkan kode OTP di response API
# dan env validation menolaknya.
# OTP_DEBUG_RETURN_CODE=false

OTP_EXPIRES_MINUTES=5
OTP_MAX_ATTEMPTS=5
OTP_LENGTH=6

# ─── Rating ──────────────────────────────────────────────────
RATING_WINDOW_DAYS=7

# ─── Export ──────────────────────────────────────────────────
EXPORT_MAX_DATE_RANGE_DAYS=90

# ─── WebSocket ───────────────────────────────────────────────
WS_AUTH_TIMEOUT_MS=10000

# ─── Upload Limits (MB) ─────────────────────────────────────
UPLOAD_MAX_AVATAR_MB=2
UPLOAD_MAX_CHAT_MB=5
UPLOAD_MAX_KYC_MB=5
UPLOAD_MAX_EVIDENCE_MB=5

# ─── Fee Rates (basis points) ───────────────────────────────
# 150 bps = 1.50%, 50 bps = 0.50%
KAHADE_FEE_RATE_BPS=150
KAHADE_PLUS_FEE_RATE_BPS=50

# ─── Payment Method Fees ────────────────────────────────────
PAYMENT_FEE_VA_BCA=4000
PAYMENT_FEE_VA_BNI=4000
PAYMENT_FEE_QRIS_PERCENT=0.7
PAYMENT_FEE_GOPAY_PERCENT=2.0

# ─── Referral Reward (basis points) ─────────────────────────
REFERRAL_REWARD_RATE_BPS=1000

# ─── Fee Savings Limit (sen) ────────────────────────────────
# 5000000 sen = Rp 50.000
FEE_SAVINGS_LIMIT=5000000

# ─── Referral ────────────────────────────────────────────────
# Maksimum penggunaan per kode referral (min 1; 0 akan block semua referral)
MAX_REFERRALS_PER_CODE=100

# ─── Bull Queue Concurrency ─────────────────────────────────
BULL_EMAIL_CONCURRENCY=5
BULL_NOTIF_CONCURRENCY=5

# ─── Redis Key Prefix ───────────────────────────────────────
REDIS_PREFIX=kahade:prod:

# ─── FCM Push Notifications (optional) ──────────────────────
# Dari Firebase Console → Project Settings → Service Accounts
# FCM_PROJECT_ID=
# FCM_CLIENT_EMAIL=
# FCM_PRIVATE_KEY=

# ─── Swagger (optional, staging only) ───────────────────────
# IP/CIDR whitelist untuk akses /docs di staging
# SWAGGER_ALLOWLIST=10.0.0.0/8,192.168.1.0/24

# ─── Error Monitoring (optional) ────────────────────────────
SENTRY_DSN=
SENTRY_TRACES_SAMPLE_RATE=0.2
```

### 6.4 Generate All Secrets

Jalankan di server, lalu paste hasilnya ke `.env`:

```bash
echo "=== JWT Secrets ==="
echo "JWT_SECRET=$(openssl rand -hex 32)"
echo "JWT_REFRESH_SECRET=$(openssl rand -hex 32)"
echo "JWT_ADMIN_SECRET=$(openssl rand -hex 32)"
echo "JWT_ADMIN_REFRESH_SECRET=$(openssl rand -hex 32)"
echo "JWT_TEMP_SECRET=$(openssl rand -hex 32)"
echo ""
echo "=== Crypto Secrets ==="
echo "AES_SECRET_KEY=$(openssl rand -hex 32)"
echo "AES_KDF_SALT=$(openssl rand -hex 32)"
echo "HMAC_SECRET_KEY=$(openssl rand -hex 32)"
echo ""
echo "=== Wallet PIN Pepper ==="
echo "WALLET_PIN_PEPPER=$(openssl rand -hex 32)"
echo ""
echo "=== Redis Password ==="
echo "REDIS_PASSWORD=$(openssl rand -hex 24)"
echo ""
echo "=== DB Password ==="
echo "DB_PASSWORD=$(openssl rand -hex 24)"
```

### 6.5 Secure the .env File

```bash
chmod 600 /var/www/kahade/apps/backend/.env
ls -la /var/www/kahade/apps/backend/.env
# -rw------- 1 kahade kahade
```

### 6.6 Build Application

```bash
cd /var/www/kahade/apps/backend
pnpm run build
```

### 6.7 Run Database Migrations

```bash
cd /var/www/kahade/apps/backend
pnpm exec prisma migrate deploy
bash scripts/run-constraints.sh
```

> Pakai `pnpm exec`, bukan `npx`. Di workspace pnpm, `npx` bisa jatuh ke
> mengunduh `prisma` versi lain dari registry kalau resolusi bin gagal —
> `pnpm exec` selalu memakai binary yang sudah terinstal dari lockfile.

Script `run-constraints.sh` menambahkan CHECK constraints PostgreSQL yang tidak bisa dikelola Prisma (non-negative balances, voucher exclusivity, order invariants, dll). Script ini idempotent — aman dijalankan berulang.

### 6.8 Test Startup

```bash
node dist/main
# Output: "KAHADE Backend running on port 3000 [production]"
# Ctrl+C untuk stop
```

Jika startup gagal, periksa pesan error — aplikasi memvalidasi semua secrets dan environment variables saat start.

**Startup akan gagal jika:**
- Secret masih berisi placeholder (`change_me`, `EXAMPLE`, `0123456789abcdef`)
- Secret kurang dari 64 karakter (berlaku untuk 5 JWT secret, `AES_SECRET_KEY`, `HMAC_SECRET_KEY`, `AES_KDF_SALT`, `WALLET_PIN_PEPPER`)
- `CORS_ORIGINS` mengandung `localhost`
- `TRUSTED_PROXY_CIDR` tidak di-set
- Required env vars kosong

---

## 7. PM2 Process Manager

### 7.1 Create Log Directory

```bash
sudo mkdir -p /var/log/kahade
sudo chown kahade:kahade /var/log/kahade
```

### 7.2 Single PM2 Configuration

PM2 tidak menjalankan checkout release secara langsung. Ia hanya menjalankan
symlink `/var/www/kahade-current`, sehingga rollback cukup mengalihkan symlink
ke release terdahulu lalu melakukan restart terkontrol. Simpan satu-satunya
konfigurasi PM2 di luar repository:

```javascript
module.exports = {
  apps: [
    {
      name: 'kahade-api',
      cwd: '/var/www/kahade-current/apps/backend',
      script: 'dist/main.js',
      instances: 1,
      exec_mode: 'fork',

      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        RUNTIME_ENV_FILE: '/var/www/kahade/apps/backend/.env',
      },
      kill_timeout: 30000,
      autorestart: true,
      watch: false,
    },
  ],
};
```

Simpan konfigurasi tersebut sebagai `/etc/kahade/kahade-api.config.cjs` dengan
owner `root:kahade` dan mode `640`. Jangan menyimpan nilai secret dalam file PM2.

### 7.3 Start Application

```bash
sudo ln -sfn /var/www/kahade-release-<SHA> /var/www/kahade-current.new
sudo mv -Tf /var/www/kahade-current.new /var/www/kahade-current

sudo -iu kahade pm2 delete kahade-api
sudo -iu kahade pm2 start /etc/kahade/kahade-api.config.cjs --update-env
curl --fail http://127.0.0.1:3000/v1/health/internal-ready
pm2 status
```

Perintah di atas hanya untuk **instalasi proses awal**. Untuk perpindahan
checkout release, ikuti Section 13: alihkan symlink atomik kemudian jalankan
`pm2 reload /etc/kahade/kahade-api.config.cjs --only kahade-api --update-env`.
Gunakan gate `/v1/health/internal-ready` untuk readiness proses. Jika gate
gagal, arahkan kembali symlink ke release sehat dan reload konfigurasi yang
sama; jangan menggunakan hasil `/v1/health` publik sebagai satu-satunya alasan
rollback karena endpoint tersebut memeriksa dependency eksternal dan di-throttle.

### 7.4 Auto-Start on Reboot

```bash
pm2 startup
# Salin dan jalankan command yang ditampilkan PM2, contoh:
# sudo env PATH=$PATH:/home/kahade/.nvm/versions/node/v20.x.x/bin pm2 startup systemd -u kahade --hp /home/kahade

pm2 save
```

### 7.5 PM2 Log Rotation

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:dateFormat YYYY-MM-DD_HH-mm-ss
pm2 set pm2-logrotate:rotateModule true
```

### 7.6 Common PM2 Commands

```bash
pm2 start kahade-api           # Start
pm2 stop kahade-api            # Stop
pm2 restart kahade-api         # Hard restart
pm2 restart kahade-api         # Restart proses aktif, bukan untuk pindah release
pm2 logs kahade-api            # Live logs
pm2 logs kahade-api --lines 200  # Last 200 lines
pm2 logs kahade-api --err      # Error logs only
pm2 monit                      # Interactive monitoring
pm2 status                     # Process table
pm2 show kahade-api            # Detailed info
```

---

## 8. Nginx Reverse Proxy

### 8.1 Create Server Block (HTTP only — temporary)

```bash
sudo nano /etc/nginx/sites-available/kahade-backend
```

```nginx
limit_req_zone $binary_remote_addr zone=api_general:10m rate=30r/s;
limit_req_zone $binary_remote_addr zone=api_auth:10m rate=5r/s;
limit_req_zone $binary_remote_addr zone=api_webhook:10m rate=10r/s;

upstream kahade_backend {
    least_conn;
    server 127.0.0.1:3000;
    keepalive 64;
}

server {
    listen 80;
    listen [::]:80;
    server_name api.kahade.id;

    location / {
        proxy_pass http://kahade_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### 8.2 Enable Site

```bash
sudo ln -s /etc/nginx/sites-available/kahade-backend /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

### 8.3 Full Production Config (setelah SSL — Section 9)

Setelah mendapatkan SSL certificate, **ganti** seluruh isi config:

```bash
sudo nano /etc/nginx/sites-available/kahade-backend
```

```nginx
limit_req_zone $binary_remote_addr zone=api_general:10m rate=30r/s;
limit_req_zone $binary_remote_addr zone=api_auth:10m rate=5r/s;
limit_req_zone $binary_remote_addr zone=api_webhook:10m rate=10r/s;

upstream kahade_backend {
    least_conn;
    server 127.0.0.1:3000;
    keepalive 64;
}

# HTTP → HTTPS redirect
server {
    listen 80;
    listen [::]:80;
    server_name api.kahade.id;
    return 301 https://$server_name$request_uri;
}

# HTTPS server
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name api.kahade.id;

    # ─── SSL (managed by Certbot) ────────────────────────────
    ssl_certificate /etc/letsencrypt/live/api.kahade.id/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.kahade.id/privkey.pem;
    ssl_trusted_certificate /etc/letsencrypt/live/api.kahade.id/chain.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;
    ssl_stapling on;
    ssl_stapling_verify on;
    resolver 8.8.8.8 8.8.4.4 valid=300s;
    resolver_timeout 5s;

    # ─── Security Headers ────────────────────────────────────
    server_tokens off;
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

    # ─── Gzip ────────────────────────────────────────────────
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css application/json application/javascript text/xml;

    # ─── Body Size Limit ─────────────────────────────────────
    client_max_body_size 10m;

    # ─── Block dotfiles ──────────────────────────────────────
    location ~ /\. {
        return 404;
    }

    # ─── Block Swagger in production ─────────────────────────
    location /docs {
        return 404;
    }
    location /docs-json {
        return 404;
    }

    # ─── Auth endpoints (stricter rate limit) ────────────────
    location ~ ^/v1/(auth|admin/auth)/ {
        limit_req zone=api_auth burst=10 nodelay;

        proxy_pass http://kahade_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # ─── Midtrans webhook (separate rate limit) ──────────────
    location /v1/payments/midtrans-webhook {
        limit_req zone=api_webhook burst=20 nodelay;

        proxy_pass http://kahade_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # ─── All other API routes ────────────────────────────────
    location / {
        limit_req zone=api_general burst=50 nodelay;

        proxy_pass http://kahade_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
```

```bash
sudo nginx -t
sudo systemctl reload nginx
```

---

## 9. SSL with Let's Encrypt

### 9.1 Obtain Certificate

```bash
sudo certbot --nginx -d api.kahade.id \
  --non-interactive --agree-tos --email admin@kahade.id
```

### 9.2 Verify Auto-Renewal

Certbot otomatis menambahkan cron/systemd timer. Test:

```bash
sudo certbot renew --dry-run
```

### 9.3 Update Nginx Config

Setelah SSL berhasil, ganti config Nginx dengan versi full production di Section 8.3 di atas, lalu:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

### 9.4 Test HTTPS

```bash
curl -s https://api.kahade.id/v1/health | jq .
```

---

## 10. Security Hardening

### 10.1 Verify Firewall

```bash
sudo ufw status verbose
# Hanya 22/tcp, 80/tcp, 443/tcp yang ALLOW IN
```

### 10.2 Verify NODE_ENV

```bash
grep NODE_ENV /var/www/kahade/apps/backend/.env
# Harus: NODE_ENV=production
```

Ini menonaktifkan Swagger docs, mengaktifkan validasi secret ketat, dan menggunakan production logging.

### 10.3 Install fail2ban

```bash
sudo apt install -y fail2ban
sudo nano /etc/fail2ban/jail.local
```

```ini
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5
destemail = admin@kahade.id
action = %(action_mwl)s

[sshd]
enabled = true
port = ssh
logpath = /var/log/auth.log
maxretry = 3
bantime = 86400

[nginx-http-auth]
enabled = true

[nginx-limit-req]
enabled = true
logpath = /var/log/nginx/error.log
maxretry = 10
findtime = 60
bantime = 3600
```

```bash
sudo systemctl enable fail2ban
sudo systemctl start fail2ban
sudo fail2ban-client status
```

### 10.4 Disable Root SSH & Password Auth

```bash
sudo nano /etc/ssh/sshd_config
```

```
PermitRootLogin no
PasswordAuthentication no
```

```bash
sudo systemctl restart sshd
```

> Pastikan SSH key sudah di-setup sebelum menonaktifkan password auth!

### 10.5 Unattended Security Upgrades

```bash
sudo apt install -y unattended-upgrades apt-listchanges
sudo dpkg-reconfigure -plow unattended-upgrades
```

### 10.6 PostgreSQL Security

```bash
sudo grep listen_addresses /etc/postgresql/16/main/postgresql.conf
# Harus: listen_addresses = 'localhost'
```

---

## 11. Monitoring & Health Checks

### 11.1 Health Endpoint

Backend memiliki health endpoint di `GET /v1/health` yang mengecek **6 indicator**:
`database`, `redis`, `disk`, `midtrans`, `r2_storage`, dan `smtp`. Ada juga
`GET /v1/health/crons` untuk heartbeat scheduler.

```bash
curl -s https://api.kahade.id/v1/health | jq .
```

Response normal:

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "status": "ok",
    "info": {
      "database":   { "status": "up" },
      "redis":      { "status": "up" },
      "disk":       { "status": "up" },
      "midtrans":   { "status": "up" },
      "r2_storage": { "status": "up" },
      "smtp":       { "status": "up" }
    }
  }
}
```

> **PENTING untuk monitoring:** endpoint ini mengembalikan **HTTP 503** kalau
> **salah satu** dari 6 indicator down — termasuk dependency eksternal seperti
> SMTP, Midtrans, atau R2. Jadi 503 **tidak** selalu berarti aplikasi mati; bisa
> jadi cuma SMTP provider yang sedang bermasalah sementara API tetap melayani
> traffic normal. Ini penting untuk Section 11.2 dan 11.3 di bawah.

> **Maintenance mode:** kalau Redis key `app:maintenance` (JSON `{"enabled":true}`)
> atau env `MAINTENANCE_MODE=true` aktif, endpoint langsung mengembalikan
> `status: "ok"` dengan `maintenance: true` **tanpa** menjalankan cek apa pun.

### 11.2 Local Health Check Script (Auto-Restart)

> **⚠️ JANGAN restart hanya berdasarkan status HTTP.** `/v1/health` mengembalikan
> 503 kalau **dependency eksternal** (SMTP, Midtrans, R2) down — padahal proses
> Node-nya sehat. Script naif yang `pm2 reload` setiap kali status ≠ 200 akan
> me-restart API **setiap 2 menit selama pemadaman SMTP**, memutus request yang
> sedang berjalan tanpa memperbaiki apa pun.
>
> Script di bawah hanya me-restart kalau backend benar-benar **tidak menjawab**
> (connection refused / timeout / 5xx tanpa body JSON), dan hanya
> mem-*log* kalau proses hidup tapi ada dependency yang down.

```bash
cat > /home/kahade/healthcheck.sh << 'SCRIPT'
#!/bin/bash
HEALTH_URL="http://127.0.0.1:3000/v1/health"
LOG=/var/log/kahade/healthcheck.log

BODY=$(curl -s --max-time 10 "$HEALTH_URL")
CURL_RC=$?

# Proses benar-benar mati / tidak menjawab dalam 10 detik → restart
if [ $CURL_RC -ne 0 ] || [ -z "$BODY" ]; then
    echo "[$(date)] ALERT: backend unreachable (curl rc=$CURL_RC) — restarting" >> "$LOG"
    pm2 restart kahade-api
    exit 0
fi

# Menjawab dengan JSON valid → proses hidup. Jangan restart; cukup log
# indicator mana yang down supaya on-call bisa lihat.
DOWN=$(echo "$BODY" | jq -r '(.data.error // {}) | keys[]?' 2>/dev/null | tr '\n' ' ')
if [ -n "$DOWN" ]; then
    echo "[$(date)] WARN: dependency down: $DOWN (proses hidup — TIDAK di-restart)" >> "$LOG"
fi
SCRIPT

chmod +x /home/kahade/healthcheck.sh
```

Tambahkan ke cron (setiap 2 menit):

```bash
crontab -e
```

```
*/2 * * * * /home/kahade/healthcheck.sh 2>&1
```

### 11.3 External Monitoring

Gunakan [UptimeRobot](https://uptimerobot.com) (gratis):

- **Monitor Type:** HTTP(s)
- **URL:** `https://api.kahade.id/v1/health`
- **Interval:** 5 menit
- **Alert:** email/Telegram

> **Catatan:** karena `/v1/health` 503 saat SMTP/Midtrans/R2 down, monitor ini
> akan memberi alert untuk gangguan dependency pihak ketiga, bukan hanya API
> down. Itu berguna — tapi jangan sambungkan ke automasi yang me-restart server.

### 11.4 Sentry Error Monitoring (Optional)

Jika `SENTRY_DSN` di-set di `.env`, error tracking otomatis aktif untuk production/staging. Sentry menangkap unhandled exceptions dengan stack trace dan profiling data.

---

## 12. Database Backup

### 12.1 Automated Daily Backup

```bash
sudo mkdir -p /var/backups/kahade
sudo chown kahade:kahade /var/backups/kahade

sudo su - kahade
cat > ~/backup-db.sh << 'SCRIPT'
#!/bin/bash
set -euo pipefail

BACKUP_DIR="/var/backups/kahade"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/kahade_prod_${TIMESTAMP}.dump"

PGPASSWORD="PASSWORD_DB_ANDA" pg_dump \
  -h 127.0.0.1 \
  -U kahade_prod \
  -d kahade_prod \
  --no-owner \
  --no-privileges \
  --format=custom \
  -f "${BACKUP_FILE}"

find "${BACKUP_DIR}" -name "kahade_prod_*.dump" -mtime +14 -delete

echo "[$(date)] Backup: ${BACKUP_FILE} ($(du -h ${BACKUP_FILE} | cut -f1))"
SCRIPT

chmod +x ~/backup-db.sh
```

> **Catatan:** `--format=custom` sudah mengompresi secara internal (zlib). Tidak perlu pipe ke `gzip`.

### 12.2 Add to Cron

```bash
crontab -e
```

```
0 2 * * * /home/kahade/backup-db.sh >> /var/log/kahade/backup.log 2>&1
```

### 12.3 Restore dari Backup

```bash
pg_restore -h 127.0.0.1 -U kahade_prod -d kahade_prod \
  --clean --if-exists --no-owner \
  /var/backups/kahade/kahade_prod_XXXXXXXX_XXXXXX.dump
```

### 12.4 Upload ke S3 (Optional)

Untuk offsite backup, tambahkan di akhir `backup-db.sh`:

```bash
if command -v aws &> /dev/null; then
  aws s3 cp "${BACKUP_FILE}" "s3://kahade-backups-prod/db/${TIMESTAMP}.dump" --storage-class STANDARD_IA
fi
```

---

## 13. Rilis Backend Terkendali

> **Aturan tunggal:** jangan `git pull`, mengedit source, atau menjalankan
> `pm2 reload` pada checkout yang sedang melayani produksi. Setiap rilis dibuat
> di direktori immutable lalu dipilih melalui symlink `kahade-current`.

### 13.1 Build Release Immutable

Tentukan commit `main` yang telah divalidasi. Buat checkout baru dengan nama
commit pendek, lalu install dari root monorepo dan build backend di dalam
checkout tersebut.

```bash
export RELEASE_SHA="<commit-main-yang-disetujui>"
export RELEASE_DIR="/var/www/kahade-release-${RELEASE_SHA}"

git clone https://github.com/kahade-id/kahade.git "$RELEASE_DIR"
cd "$RELEASE_DIR"
git checkout --detach "$RELEASE_SHA"
pnpm install --frozen-lockfile

cd apps/backend
DATABASE_URL='postgresql://placeholder:placeholder@127.0.0.1:5432/placeholder' \
  pnpm exec prisma generate
pnpm exec nest build
test -f dist/main.js
```

### 13.2 Migration dan Smoke Read-Only

Migration database tidak dijalankan otomatis oleh prosedur rilis. Bila commit
memiliki migration, buat backup database terverifikasi dan dapatkan persetujuan
operator sebelum menjalankan `prisma migrate deploy`.

Sebelum cutover, jalankan kandidat pada port loopback berbeda dengan
`SMOKE_MODE=true`, `HOST=127.0.0.1`, dan `SMOKE_ENV_FILE` menunjuk ke satu file
legacy `/var/www/kahade/apps/backend/.env`. Smoke mode tidak boleh memuat
worker, scheduler, queue, WebSocket, atau route bisnis. Health harus `200`,
route `/v1/orders` harus `404`, dan listener hanya boleh berada di loopback.

### 13.3 Cutover

Setelah smoke lulus, alihkan symlink secara atomik dan mulai ulang PM2 dengan
file tunggal `/etc/kahade/kahade-api.config.cjs`. **Jangan melakukan polling
`/v1/health` untuk menentukan readiness deployment.** Endpoint health publik
secara sengaja dibatasi rate-limit dan memeriksa SMTP, Midtrans, serta R2;
respons `429` atau `503` tidak membuktikan proses API gagal boot.

Gunakan `GET /v1/health/internal-ready` hanya melalui `127.0.0.1` sebagai gate
cutover. Route ini tidak melakukan mutasi, tidak memuat route bisnis, tidak
melakukan fan-out ke dependency eksternal, dan menolak request yang memiliki
`X-Forwarded-For` atau berasal dari non-loopback. Endpoint tersebut tidak boleh
dipanggil melalui Nginx atau dipublikasikan sebagai monitor eksternal.

```bash
sudo ln -sfn "$RELEASE_DIR" /var/www/kahade-current.new
sudo mv -Tf /var/www/kahade-current.new /var/www/kahade-current

sudo -iu kahade pm2 reload /etc/kahade/kahade-api.config.cjs --only kahade-api --update-env

# Tunggu marker bootstrap dan readiness proses; timeout eksplisit menghindari
# rollback palsu saat modul normal membutuhkan waktu inisialisasi.
for _ in $(seq 1 24); do
  curl --fail --silent --max-time 5 http://127.0.0.1:3000/v1/health/internal-ready \
    && break
  sleep 10
done
curl --fail --silent --max-time 5 http://127.0.0.1:3000/v1/health/internal-ready
sudo -iu kahade pm2 save

# Observabilitas pasca-cutover, bukan gate rollback. Panggil sekali saja;
# 429 berarti rate-limit monitor, 503 dapat berarti dependency eksternal down.
curl --silent --max-time 10 https://api.kahade.id/v1/health || true
```

### 13.4 Rollback

Jika build, smoke, startup, atau health gagal, jangan mengubah database atau
source. Arahkan symlink ke release terakhir yang sehat, mulai ulang memakai file
PM2 yang sama, dan verifikasi health lokal serta publik.

```bash
sudo ln -sfn /var/www/kahade-release-<SHA_SEBELUMNYA> /var/www/kahade-current.new
sudo mv -Tf /var/www/kahade-current.new /var/www/kahade-current
sudo -iu kahade pm2 delete kahade-api
sudo -iu kahade pm2 start /etc/kahade/kahade-api.config.cjs --update-env
sleep 8
curl --fail http://127.0.0.1:3000/v1/health
sudo -iu kahade pm2 save
```

> **Peringatan:** rollback aplikasi tidak membatalkan migration database.
> Migration harus backward-compatible atau memiliki rencana pemulihan data yang
> disetujui sebelum dijalankan.

---

## 14. Docker Deployment (Alternative)

Jika Anda memilih Docker daripada bare-metal PM2:

### 14.1 entrypoint.sh

File `entrypoint.sh` sudah ada di repo. Script ini menjalankan:

1. `prisma migrate deploy`
2. `scripts/run-constraints.sh` (CHECK constraints)
3. `node dist/main`

> **Catatan tentang concurrent migrations:** Prisma `migrate deploy` memakai
> mekanisme lock internal pada tabel `_prisma_migrations`. Setelah migration,
> `scripts/run-constraints.sh` menjalankan semua CHECK/index constraints dalam
> satu transaction dengan `pg_advisory_xact_lock(202603211)`, sehingga dua
> container yang start bersamaan tidak dapat menerapkan batch constraints secara
> paralel atau meninggalkan partial batch. Jika deployment memakai banyak replica,
> tetap lebih baik menjalankan migration/constraint step sebagai init job sebelum
> replica API dinaikkan.

Isi `entrypoint.sh` yang sebenarnya ada di repo:

```bash
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
```

### 14.2 Dockerfile monorepo dan build context

`apps/backend/Dockerfile` memakai pnpm workspace dan committed lockfile. Build
context **harus root repository**, bukan `apps/backend`, agar
`pnpm-lock.yaml`, `pnpm-workspace.yaml`, dan root `package.json` tersedia.
Dockerfile menjalankan filtered frozen install, build Prisma/Nest, lalu membuat
isolated production dependency tree dengan `pnpm deploy --legacy --prod`.
Prisma CLI berada di production dependencies karena entrypoint menjalankan
migration saat startup.

```bash
cd /var/www/kahade
docker build -f apps/backend/Dockerfile -t kahade-api:latest .
```

### 14.3 Build & Run

```bash
# Context HARUS root repo agar pnpm-lock.yaml & pnpm-workspace.yaml ikut terbawa
cd /var/www/kahade

# Build image (hanya setelah Dockerfile diperbaiki — lihat 14.2)
docker build -f apps/backend/Dockerfile -t kahade-api:latest .

# Atau gunakan docker-compose (PostgreSQL + Redis + API)
docker compose up -d
```

### 14.4 docker-compose.yml

File `docker-compose.yml` sudah ada di repo. Untuk production, buat `.env` dengan semua variable lalu:

```bash
NODE_ENV=production docker compose up -d
```

> **Catatan:** Untuk production serius, disarankan menggunakan managed PostgreSQL (AWS RDS, DigitalOcean Managed DB) daripada PostgreSQL dalam container.

---

## 15. Client Apps (Expo / EAS)

> **Penting:** kedua client adalah **aplikasi Expo (React Native)**, bukan web app.
> Tidak ada deployment Vercel, tidak ada Next.js, tidak ada Vite, dan tidak ada
> `NEXT_PUBLIC_*` / `VITE_*`. Keduanya di-build lewat **EAS Build** dan
> didistribusikan sebagai APK / AAB / IPA. Env var untuk client harus berprefix
> `EXPO_PUBLIC_` dan sudah ditulis di `eas.json` per profil, jadi tidak perlu
> di-set manual di dashboard mana pun.

Fakta aktual kedua app (dari `app.json`):

| | Mobile (user) | Admin |
|:--|:--|:--|
| Nama | Kahade | Kahade Admin |
| Slug | `kahade-mobile` | `kahade-admin` |
| Version | 1.0.2 | 1.0.0 |
| Package / Bundle ID | `id.kahade.app` | `id.kahade.admin` |
| EAS project ID | `4ee499f6-e773-4fbd-be8b-6f2a4802a2e2` | `e0d43b7e-4f6e-423e-a365-f53e91b8f07c` |
| EAS owner | `kahade` | `kahade` |
| Runtime version policy | `appVersion` | `appVersion` |

### 15.1 Prasyarat build client

Dijalankan sekali di mesin developer (bukan di EC2 — EAS build jalan di cloud):

```bash
# Node 20 LTS + pnpm (repo ini pnpm workspace, packageManager: pnpm@10.26.1)
corepack enable
corepack prepare pnpm@10.26.1 --activate

# EAS CLI
pnpm add -g eas-cli
eas login                      # akun yang punya akses ke owner "kahade"
eas whoami                     # verifikasi
```

Install dependency dari **root repo**, bukan per app — ini workspace:

```bash
cd /path/to/kahade          # root repo, bukan apps/mobile atau apps/admin
pnpm install --frozen-lockfile
```

> `--frozen-lockfile` penting: EAS Build menjalankan install dengan `CI=true`,
> yang membuat pnpm memakai frozen-lockfile secara default. Kalau
> `pnpm-lock.yaml` tertinggal dari `package.json`, build **gagal di cloud**
> dengan `ERR_PNPM_OUTDATED_LOCKFILE`. Pakai flag yang sama secara lokal supaya
> ketidakcocokan ketahuan sebelum menghabiskan kuota build.

### 15.2 Sinkronkan SDK dari OpenAPI backend

Kedua client generate tipe dari `apps/backend/openapi.json`. Jalankan ini
**setiap kali API contract backend berubah**, sebelum build:

```bash
# 1. Regenerate spec di backend (butuh Postgres + Redis hidup, karena
#    script ini boot AppModule)
cd apps/backend
pnpm run openapi:generate

# 2. Salin + generate tipe di kedua client
cd ../mobile && pnpm run sdk:update
cd ../admin  && pnpm run sdk:update
```

`sdk:update` = `sdk:fetch` (copy `openapi.json`) + `sdk:generate`
(`openapi-typescript` → `lib/api/openapi-types.ts`).

Kalau tipe hasil generate tidak cocok dengan pemakaian di kode, `typecheck` akan
gagal — itu memang tujuannya, jangan di-bypass.

### 15.3 Verifikasi sebelum build (wajib, mencegah build gagal di cloud)

EAS build memakan waktu dan kuota. Selalu lolos gate ini dulu secara lokal:

```bash
# Mobile
cd apps/mobile
pnpm run typecheck        # tsc --noEmit
pnpm run lint
pnpm test

# Admin (tidak punya script lint/test)
cd ../admin
pnpm run typecheck
```

Lalu pastikan JS bundle benar-benar bisa dibundel — ini yang menangkap error
resolusi module / import sebelum EAS:

```bash
cd apps/mobile
npx expo export --platform android --output-dir /tmp/expo-export-mobile --clear

cd ../admin
npx expo export --platform android --output-dir /tmp/expo-export-admin --clear
```

Berhasil kalau berakhir dengan `Exported: /tmp/...` dan exit code 0.

> **Catatan lingkungan:** di sebagian environment (container/PRoot/CPU tanpa
> instruksi yang dibutuhkan Hermes) `expo export` bisa gagal dengan
> `hermesc ... exited with signal: SIGILL`. Itu keterbatasan mesin, **bukan**
> error project. Tambahkan `--no-bytecode` untuk memvalidasi graph JS-nya:
> `npx expo export --platform android --no-bytecode --output-dir /tmp/out --clear`.
> EAS Build (Linux x86_64 normal) tidak terkena ini, jadi jangan mematikan
> Hermes di `app.json` karena alasan ini.

Terakhir, cek konsistensi konfigurasi Expo:

```bash
npx expo-doctor
npx expo config --type public --json | head -40   # pastikan slug/version/package benar
```

`apps/mobile/app.config.js` membungkus `app.json` untuk plugin Sentry dan hanya
mengaktifkan Sentry bila `EXPO_PUBLIC_SENTRY_DSN` ada. `expo-doctor` bisa
melaporkan "app.config.js is not using values from app.json" — itu false
positive; `app.config.js` memang `require("./app.json")` dan seluruh nilainya
dipertahankan (buktikan dengan perintah `expo config` di atas).

### 15.4 Build profiles (`eas.json`)

Kedua app punya profil identik namanya:

| Profil | Output | Kapan dipakai |
|:--|:--|:--|
| `development` | APK, dev client, `distribution: internal` | debugging dengan dev client |
| `preview` | APK, `distribution: internal` | QA / tester internal |
| `production-apk` | APK, `autoIncrement` | distribusi langsung (bukan Play Store) |
| `production` | AAB (app-bundle) | upload ke Google Play |

Semua profil sudah menyuntikkan `EXPO_PUBLIC_API_URL=https://api.kahade.id/v1`.
Profil mobile juga menyuntikkan Sentry DSN + `SENTRY_DISABLE_AUTO_UPLOAD=true`.

**Backend harus sudah live di `https://api.kahade.id/v1` sebelum build**, karena
URL itu ter-embed di binary. Verifikasi: `curl -sS https://api.kahade.id/v1/health`.

### 15.5 Menjalankan build

```bash
cd apps/mobile

# APK untuk tester
eas build --platform android --profile preview

# AAB untuk Play Store
eas build --platform android --profile production

# iOS (butuh akun Apple Developer)
eas build --platform ios --profile production
```

Sama untuk `apps/admin` (ganti direktori). Build pertama akan menanyakan
pembuatan keystore Android — pilih "generate new keystore" dan biarkan EAS yang
menyimpannya. **Jangan** kehilangan keystore untuk app yang sudah di Play Store;
`eas credentials` untuk mem-backup.

Submit ke store:

```bash
cd apps/mobile
eas submit --platform android --profile production
eas submit --platform ios --profile production
```

> **⚠️ `eas submit` Android belum siap dipakai apa adanya.**
>
> **Mobile:** `apps/mobile/eas.json` menunjuk
> `submit.production.android.serviceAccountKeyPath: "./google-services-key.json"`,
> tapi **file itu tidak ada di repo** (memang benar — service account key tidak
> boleh di-commit). Sebelum submit, unduh JSON service account dari Google Play
> Console → Setup → API access, simpan sebagai
> `apps/mobile/google-services-key.json`, dan pastikan ter-ignore git.
>
> **Admin:** `apps/admin/eas.json` **tidak punya section `submit` sama sekali**,
> jadi `eas submit` di direktori itu akan meminta konfigurasi interaktif atau
> gagal. Kalau admin app memang tidak didistribusikan lewat Play Store (wajar
> untuk app internal), gunakan profil `production-apk` dan bagikan APK-nya
> langsung — jangan jalankan `eas submit` untuk admin.

### 15.6 OTA update (hanya untuk perubahan JS)

Keduanya pakai `runtimeVersion.policy: "appVersion"`, jadi OTA hanya sampai ke
binary dengan `version` yang **sama persis**. Kalau menaikkan `version` di
`app.json`, wajib build ulang — OTA tidak akan menjangkau versi lama.

```bash
cd apps/mobile
eas update --branch production --message "fix: ..."
```

Perubahan native (tambah/hapus/upgrade native module, ganti permission,
ubah plugin) **tidak bisa** dikirim via OTA. Harus build ulang.

> Mobile menyetel `updates.checkAutomatically: "NEVER"`, artinya app tidak
> memeriksa update saat start; pemeriksaan dilakukan kode app sendiri. Jangan
> berasumsi OTA langsung terpasang setelah `eas update` selesai.

### 15.7 CORS untuk client Expo

`CORS_ORIGINS` hanya berlaku untuk klien berbasis browser — Swagger UI, dan
`expo start --web` bila dipakai. App Expo native tidak mengirim header `Origin`,
jadi build mobile/admin tidak bergantung pada nilai ini.

```env
CORS_ORIGINS=https://kahade.id,https://www.kahade.id,https://admin.kahade.id
```

Untuk staging, tambahkan origin staging-nya sendiri. Jangan pernah memakai `*`
di production: endpoint finansial memakai cookie/CSRF, dan wildcard origin
melumpuhkan proteksinya.

### 15.8 Required HTTP Headers

Client harus mengirim headers ini untuk operasi finansial:

| Header | Kapan | Format |
|:-------|:------|:-------|
| `Authorization` | Semua authenticated request | `Bearer <jwt>` |
| `Idempotency-Key` | Topup, withdraw, create order | UUID v4 unik per request |
| `X-2FA-Code` | Endpoint yang butuh 2FA | 6-digit TOTP code |
| `X-CSRF-Token` | Endpoint mutation (POST/PUT/DELETE) | Token dari cookie |
| `Content-Type` | Semua request dengan body | `application/json` |

---

## 16. Production Considerations

### 16.1 Startup Secret Validation

Aplikasi memvalidasi semua secrets saat startup (`src/main.ts`). Di `production`/`staging`, server **menolak start** jika:

- Secret masih placeholder (`change_me`, `EXAMPLE`)
- JWT/AES/HMAC key < 64 karakter
- `CORS_ORIGINS` mengandung `localhost`
- `TRUSTED_PROXY_CIDR` tidak di-set

### 16.2 Trust Proxy

Setting `trust proxy` ke `TRUSTED_PROXY_CIDR` (default `127.0.0.1/32` untuk single Nginx). Jika ada CDN/load balancer di depan Nginx, sesuaikan. Tanpa ini, rate limiting dan IP logging menerima IP proxy, bukan client.

### 16.3 Cron Schedulers

Backend menjalankan **21** cron scheduler (semua di `src/modules/scheduler/services/`).
Kolom "Job name" adalah nama di `@Cron({ name })` — itulah yang dipakai sebagai
Redis lock key dan heartbeat key, jadi pakai nama ini saat mencari di log.

| Job name | Frekuensi | Fungsi |
|:---------|:----------|:-------|
| `expire-dispute-calls` | Tiap menit | Expire dispute call yang lewat batas waktu |
| `dlq-monitor` | Tiap 5 menit | Monitor dead-letter queue Bull |
| `pending-withdraw-cleanup` | Tiap 5 menit | Refund withdrawal stuck tanpa konfirmasi OTP |
| `withdrawal-reconciliation` | Tiap 5 menit (WIB) | Rekonsiliasi status withdrawal vs Midtrans Iris |
| `expire-unconfirmed-orders` | Tiap 10 menit | Expire order yang tidak dikonfirmasi seller |
| `expire-unpaid-orders` | Tiap 10 menit | Expire order yang tidak dibayar |
| `subscription-expiry` | Tiap 15 menit | Tandai subscription expired |
| `proof-expiry` | Tiap 15 menit | Expire proof/bukti yang lewat deadline |
| `topup-counter-correction` | Tiap 15 menit (WIB) | Koreksi counter topup harian |
| `deadline-reminders` | Tiap 30 menit | Kirim reminder deadline order |
| `auto-complete-orders` | Tiap jam | Release escrow ke seller untuk order lewat deadline |
| `auto-escalate-disputes` | Tiap jam | Escalate disputes yang melewati SLA |
| `pending-topup-cleanup` | Tiap jam | Bersihkan topup pending yang kedaluwarsa |
| `fraud-challenge-escalation` | Tiap 4 jam (WIB) | Escalate fraud challenge yang tidak direspons |
| `wallet-daily-reset` | Harian 00:00 WIB | Reset counter topup/withdraw harian (transaksi batched 5000) |
| `data-cleanup` | Harian 03:00 WIB | Hapus OTP expired, token lama, anonymize deleted users (GDPR) |
| `daily-reconciliation` | Harian 03:00 WIB | Verifikasi invariant `available + escrow = total` semua wallet (wallet batched 500) |
| `redis-hash-cleanup` | Harian 03:30 WIB | Bersihkan Redis hash orphan |
| `process-scheduled-withdrawals` | Harian 06:00 WIB | Proses withdrawal terjadwal |
| `notification-archival` | Harian 10:00 WIB | Arsipkan notifikasi lama |
| `orphaned-upload-cleanup` | Harian 11:00 WIB | Hapus upload R2 tanpa record induk |

> **Catatan penamaan:** file `weekly-reconciliation.service.ts` **menyesatkan** —
> cron-nya `0 3 * * *` (harian, bukan mingguan) dan job name-nya
> `daily-reconciliation`. Cari log/heartbeat dengan nama `daily-reconciliation`;
> tidak ada job bernama "weekly".

> **Catatan timezone:** job yang tidak menyebut `timeZone` mengikuti **waktu lokal
> server** — itulah sebabnya `timedatectl set-timezone Asia/Jakarta` (Section 3)
> wajib. Sebagian job memakai `timeZone: 'UTC'` eksplisit di kode; kolom di atas
> sudah dikonversi ke WIB. Tiga job menumpuk di sekitar 03:00 WIB
> (`data-cleanup`, `daily-reconciliation`, lalu `redis-hash-cleanup` 03:30) —
> pertimbangkan saat menjadwalkan backup agar tidak bentrok I/O.

Semua scheduler menggunakan **Redis distributed lock** (`SET NX` + TTL) — aman untuk multi-instance PM2 cluster. Setiap job memproses record secara batch dengan per-item error isolation (satu record gagal tidak menghentikan batch).

### 16.4 Idempotency Keys

**15 endpoint** memakai decorator `@Idempotency()` dan memerlukan header
`Idempotency-Key` berisi UUID v4 unik — bukan hanya topup/withdraw/create order:

| Modul | Jumlah | Contoh operasi |
|:--|:--|:--|
| `wallet.controller.ts` | 3 | topup, withdraw, **transfer** |
| `orders.controller.ts` | 8 | create, confirm, pay, process, dan transisi order lain |
| `subscriptions.controller.ts` | 3 | subscribe, upgrade, cancel |
| `chat.controller.ts` | 1 | kirim message |

Record disimpan di Redis dengan TTL 24 jam (konfigurasi `IDEMPOTENCY_TTL_SECONDS`).

**Fail-closed behavior (post-audit):** Dengan `IDEMPOTENCY_FAIL_OPEN=false` (default yang direkomendasikan), jika Redis tidak tersedia, endpoint finansial akan mengembalikan **503 Service Unavailable** alih-alih melewatkan pengecekan idempotency. Ini mencegah duplikasi transaksi finansial saat Redis down.

### 16.5 Wallet Optimistic Locking

Balance wallet menggunakan optimistic concurrency (`version` field). Dua request concurrent ke wallet yang sama — satu akan gagal dengan conflict error dan client harus retry.

### 16.6 Graceful Shutdown

`app.enableShutdownHooks()` menangani SIGTERM/SIGINT:
- HTTP request in-flight diselesaikan
- Prisma transaction aktif selesai
- Bull queue worker di-drain

PM2 `kill_timeout: 30000` memberikan 30 detik untuk proses selesai.

### 16.7 Swagger Docs

Swagger di `/docs` dikontrol oleh `NODE_ENV` **dan** `SWAGGER_ALLOWLIST`
(`main.ts:246`):

```ts
const swaggerEnabled = process.env.NODE_ENV === 'development' ||
  (process.env.NODE_ENV !== 'production' && !!process.env.SWAGGER_ALLOWLIST);
```

- **`development`**: Swagger aktif tanpa restriksi
- **`staging`**: Swagger aktif **hanya jika** `SWAGGER_ALLOWLIST` di-set. Tanpa
  variable itu Swagger **mati total** — bukan "aktif tapi dibatasi".
- **`production`**: Swagger dinonaktifkan sepenuhnya, apa pun isi allowlist

> **Wildcard menyebabkan startup gagal.** Entri `*`, `0.0.0.0/0`, `::/0`, atau
> CIDR `/0` apa pun ditolak dengan throw saat startup (`main.ts:255-269`).
> Isi dengan IP eksplisit atau CIDR sempit saja.

Nginx config juga memblokir `/docs` dan `/docs-json` sebagai safeguard tambahan.

### 16.8 WebSocket CORS & Auth

WebSocket (Socket.IO) menggunakan `CorsIoAdapter` di `main.ts` yang membaca `CORS_ORIGINS` — origin allowlist yang **sama** dengan HTTP CORS. Ini menjamin:
- Hanya domain yang diizinkan bisa membuka koneksi WebSocket
- CORS di-set saat Socket.IO server creation (bukan post-init mutation)
- Credentials (`cookies`, `Authorization` header) diteruskan

**Auth flow WebSocket:**
1. Client mengirim JWT via `auth.token`, `Authorization` header, atau cookie
2. Server memverifikasi token (audience, issuer, signature)
3. Server cek Redis: token blacklist + session revocation
4. **Fail-closed**: Jika Redis tidak tersedia, koneksi **ditolak** (bukan diizinkan)

### 16.9 Midtrans Webhook Security

Webhook `POST /v1/payments/midtrans-webhook` memvalidasi:
1. IP request terhadap `MIDTRANS_ALLOWED_CIDRS` (IPv4 + IPv6 CIDR matching)
2. SHA-512 signature notification menggunakan `MIDTRANS_SERVER_KEY` (constant-time compare)
3. Redis idempotency key untuk terminal status — mencegah double-processing

Pastikan `X-Real-IP` header di Nginx melewatkan IP client asli.

> **Penting:** `MIDTRANS_BYPASS_IP_CHECK=true` ditolak di **production DAN staging** (`payment.service.ts:262`) — flag di-log sebagai error lalu diabaikan, IP allowlist tetap aktif. Bypass hanya berfungsi di `development`/`test`.

### 16.10 Data Protection & GDPR

- **PII Encryption**: Semua PII (NIK, alamat, nomor rekening) dienkripsi AES-256-GCM di database, dengan HMAC-SHA256 dedup hash untuk pencarian
- **KYC Documents**: S3 key disimpan terenkripsi; admin akses via presigned URL (5 menit TTL), audit-logged
- **Soft Delete**: User, bank account, admin user, chat message menggunakan soft-delete via Prisma `$extends` middleware
- **Data Anonymization**: `DataCleanupService` anonymisasi user yang dihapus 30+ hari (email→`deleted-{id}@kahade.invalid`, semua PII di-blank)
- **Audit Retention**: Audit log dipertahankan 5 tahun sesuai OJK requirement

### 16.11 Database Constraints

Script `scripts/run-constraints.sh` menambahkan CHECK constraints PostgreSQL yang tidak bisa dikelola Prisma:

| Constraint | Tabel | Fungsi |
|:-----------|:------|:-------|
| `wallet_balances_non_negative` | wallets | Balance ≥ 0 |
| `wallet_balance_invariant` | wallets | `total = available + escrow` |
| `order_amounts_non_negative` | orders | `buyerPay ≥ sellerReceive ≥ 0` |
| `dispute_split_percent_sum` | dispute_decisions | Split buyer% + seller% = 100 |
| `rating_stars_range` | ratings | Stars 1-5 |
| `referral_no_self` | referral_relations | `referrerId ≠ refereeId` |
| `user_stats_non_negative` | users | Stats dan rating ≥ 0 |
| `kyc_one_pending_per_user` | kyc_requests | Partial unique index: 1 PENDING per user |

Script idempotent — aman dijalankan berulang.

> **PENTING — hook `postprisma:migrate` TIDAK jalan di production.** Hook itu
> hanya ter-trigger lewat `pnpm run prisma:migrate` (yang memanggil
> `prisma migrate dev` — dev-only). Perintah production `prisma migrate deploy`
> memanggil binary Prisma langsung, jadi tidak ada pre/post hook npm yang jalan.
> **Panggil constraints secara eksplisit setelah setiap migrasi:**
>
> ```bash
> pnpm run db:constraints
> ```
>
> Kalau ini dilewat, CHECK constraints tidak pernah terpasang di production.

### 16.12 Wallet PIN Pepper

`WALLET_PIN_PEPPER` bukan sekadar di-prepend. Skema sebenarnya:

```
bcrypt( base64( HMAC-SHA256(pepper, pin) ) )
```

Lihat `hmacPinDigest()` di `src/common/utils/crypto.util.ts:252`. Dipakai di
`wallet.service.ts` (set PIN, verify PIN, withdraw, transfer) dan
`auth.service.ts:562`. Skema lama `bcrypt(pepper + pin)` masih diterima sebagai
**fallback legacy** dengan auto-rehash ke skema baru saat user berhasil login
(`wallet.service.ts:608-612`) — jadi upgrade skema tidak memaksa user reset PIN.

**Aturan penting:**
- **WAJIB di-set** — tidak ada fallback ke empty string. Startup akan **ditolak**
  kalau kosong, divalidasi di 4 tempat: `main.ts` (`REQUIRED_SECRETS` +
  `HIGH_ENTROPY_SECRETS`), `env.validation.ts`, `app.config.ts`, dan constructor
  `WalletService`.
- Generate sekali saat setup awal: `openssl rand -hex 32` (64 karakter — minimum
  `MIN_SECRET_LENGTH` adalah 64, jadi jangan pakai `-base64 32` yang cuma 44)
- **JANGAN pernah mengubah** setelah user sudah set PIN — semua PIN yang ada akan invalid
- Nilai harus **identik** di semua environment yang share database yang sama

### 16.13 Post-Audit Deployment Notes (rev 3)

Perubahan berikut mempengaruhi deployment setelah audit. Pastikan sudah diterapkan saat upgrade:

| Perubahan | Dampak | Aksi |
|:----------|:-------|:-----|
| `WALLET_PIN_PEPPER` (baru) | PIN withdrawal auth | **Wajib** — generate `openssl rand -hex 32`. JANGAN set kosong: startup akan gagal (`STARTUP ABORTED`). PIN lama tetap valid lewat legacy-rehash path. |
| `IDEMPOTENCY_FAIL_OPEN=false` | Financial endpoint 503 saat Redis down | Pastikan Redis HA — downtime Redis = downtime financial API |
| Reconciliation batching | Memory usage berkurang signifikan | Tidak perlu aksi — otomatis batch 5000 per query |
| Dispute wallet lock ordering | Mencegah deadlock | Tidak perlu aksi — otomatis sort by wallet ID |
| FEE_DEDUCT audit trail | Audit balanceBefore/After akurat | Tidak perlu aksi — otomatis |

**Upgrade dari versi sebelum audit:** tambahkan `WALLET_PIN_PEPPER` melalui
editor aman pada satu file legacy `/var/www/kahade/apps/backend/.env`, lalu
gunakan prosedur immutable di Section 13. Jangan menambah environment variable
melalui `echo`, jangan melakukan `git pull` pada runtime, dan jangan melakukan
`pm2 reload` untuk memindahkan source release.

---

## 17. FCM Push Notifications (Optional)

Untuk mengaktifkan push notification ke perangkat mobile:

### 17.1 Setup Firebase

1. Buka [Firebase Console](https://console.firebase.google.com/)
2. Buat/pilih project
3. Pergi ke **Project Settings → Service Accounts**
4. Klik **Generate New Private Key**
5. Download JSON file

### 17.2 Set Environment Variables

Dari JSON service account, ambil value berikut dan set di `.env`:

```env
FCM_PROJECT_ID=your-firebase-project-id
FCM_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com
FCM_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQ...\n-----END PRIVATE KEY-----\n"
```

> **Penting:** Ketiga variable (`FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY`) harus di-set semua atau tidak sama sekali. Kalau hanya sebagian, aplikasi **tetap start normal** tapi push notification **diam-diam mati** — yang muncul cuma satu baris log `FCM credentials not configured — push notifications disabled` (`push.service.ts:24`). Ini gagal secara senyap, jadi cek log startup setelah mengonfigurasi FCM.

### 17.3 Verifikasi

Jika FCM credentials **tidak** dikonfigurasi, log akan menunjukkan warning:
```
[PushService] FCM credentials not configured — push notifications disabled
```

Jika credentials dikonfigurasi dengan benar, warning tersebut **tidak** akan muncul dan push notification akan aktif.

### 17.4 Broadcast dari Admin

Panel admin SUPER_ADMIN menyediakan dua kanal broadcast: `in_app` untuk menyimpan pesan ke inbox dan `push` untuk mengantrekan pesan ke device yang memiliki token native FCM. Kedua kanal dapat dipilih bersamaan; pada kombinasi tersebut worker hanya membuat satu record notifikasi durable per user lalu mengirim push dari record yang sama, sehingga tidak terjadi duplikasi inbox.

Broadcast push diproses asynchronous melalui queue dalam batch maksimal 500 job. Response endpoint menampilkan `recipientCount`, `queuedCount`, dan `pushRequested`; `queuedCount` menunjukkan job yang berhasil masuk queue, bukan jaminan perangkat sudah menampilkan notifikasi. Token FCM yang ditolak sebagai invalid akan dibersihkan otomatis dari `user_devices`, sedangkan token native iOS tidak dikirim melalui FCM Admin karena token tersebut menggunakan APNs.

---

## 18. Staging Environment

### 18.1 Setup Staging

Staging menggunakan infrastruktur yang sama dengan production, tapi dengan perbedaan:

| Aspek | Production | Staging |
|:------|:-----------|:--------|
| `NODE_ENV` | `production` | `staging` |
| Database | `kahade_prod` | `kahade_staging` |
| Redis prefix | `kahade:prod:` | `kahade:staging:` |
| Midtrans | Production keys | Sandbox keys (`SB-Mid-*`) |
| `MIDTRANS_IS_PRODUCTION` | `true` | `false` |
| Swagger | Disabled | Enabled (IP-restricted via `SWAGGER_ALLOWLIST`) |
| `CORS_ORIGINS` | Production domains | Staging domains |
| Sentry | Enabled | Enabled (separate DSN recommended) |

### 18.2 Key Staging .env Differences

```env
NODE_ENV=staging
DATABASE_URL=postgresql://kahade_staging:PASSWORD@127.0.0.1:5432/kahade_staging?connection_limit=10
REDIS_PREFIX=kahade:staging:
MIDTRANS_IS_PRODUCTION=false
MIDTRANS_IRIS_IS_PRODUCTION=false
MIDTRANS_SERVER_KEY=SB-Mid-server-xxxxxxxxxxxxxxxxxxxx
MIDTRANS_CLIENT_KEY=SB-Mid-client-xxxxxxxxxxxxxxxxxxxx
SWAGGER_ALLOWLIST=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16
CORS_ORIGINS=https://staging.kahade.id,https://admin-staging.kahade.id

# Sering terlupa di staging — ketiganya WAJIB, startup gagal tanpa ini:
TRUSTED_PROXY_CIDR=127.0.0.1/32
WALLET_PIN_PEPPER=            # openssl rand -hex 32 (64 karakter)
BULL_REDIS_URL=redis://:PASSWORD@127.0.0.1:6379/1
```

> Blok di atas hanya **selisih** terhadap production — semua variable wajib
> lainnya (5 JWT secret, AES/HMAC, R2, SMTP, OTP) tetap harus diisi. Staging
> menjalankan validasi yang sama ketatnya dengan production.

### 18.3 Staging Validations

Staging memiliki validasi yang sama dengan production:
- Semua secret harus non-placeholder dan ≥64 karakter
- `TRUSTED_PROXY_CIDR` wajib di-set
- JWT config throw jika secret kosong
- `CORS_ORIGINS` tidak boleh berisi wildcard (`*`)

Swagger docs **aktif di staging hanya kalau `SWAGGER_ALLOWLIST` di-set** — tanpa variable itu Swagger mati total (lihat 16.7). Midtrans IP allowlist bypass via `MIDTRANS_BYPASS_IP_CHECK` **tidak berfungsi di staging**: kode menolaknya di production maupun staging (`payment.service.ts:262`), flag di-log sebagai error lalu diabaikan.

Perbedaan validasi yang perlu diketahui: cek `CORS_ORIGINS` mengandung `localhost` **hanya berlaku di production** (`main.ts:97`), tidak di staging.

---

## 19. Troubleshooting

### 19.1 Startup Gagal: "STARTUP ABORTED"

```
STARTUP ABORTED: The following secrets are missing...
```

**Solusi:** Isi semua secret di `.env` dengan value yang benar. Jalankan command di Section 6.4 untuk generate.

### 19.2 Startup Gagal: "TRUSTED_PROXY_CIDR must be set"

**Solusi:** Tambahkan ke `.env`:
```
TRUSTED_PROXY_CIDR=127.0.0.1/32
```

### 19.3 Database Connection Error

```bash
psql -U kahade_prod -d kahade_prod -h 127.0.0.1 -W
```

Jika gagal:
- Cek PostgreSQL running: `sudo systemctl status postgresql`
- Cek `pg_hba.conf` sudah ada entry untuk `kahade_prod`
- Cek password di `DATABASE_URL` benar

### 19.4 Redis Connection Error

```bash
redis-cli -a PASSWORD ping
```

Jika gagal:
- Cek Redis running: `sudo systemctl status redis-server`
- Cek password di `redis.conf` sama dengan `REDIS_PASSWORD` di `.env`

### 19.5 502 Bad Gateway dari Nginx

- Cek PM2 running: `pm2 status`
- Cek port benar: `curl http://127.0.0.1:3000/v1/health`
- Cek Nginx config: `sudo nginx -t`
- Cek log Nginx: `sudo tail -f /var/log/nginx/error.log`

### 19.6 Migration Gagal

```bash
cd /var/www/kahade/apps/backend
pnpm exec prisma migrate deploy
```

Jika error "migration not found":
- Pastikan direktori `prisma/migrations/` lengkap dari git
- Pastikan `DATABASE_URL` di `.env` benar

Jika error "constraint already exists":
- Script `run-constraints.sh` idempotent, aman dijalankan ulang
- Jika masih error, cek log detail dan fix manual via `psql`

### 19.7 Email Tidak Terkirim

- Cek `SMTP_*` config di `.env`
- Cek PM2 error log: `pm2 logs kahade-api --err`
- Bull queue retry 3x dengan exponential backoff — cek apakah semua attempt gagal

### 19.8 WebSocket Connection Gagal

- Cek CORS origins: domain frontend harus ada di `CORS_ORIGINS`
- Cek log: `Redis unavailable during WS auth` → Redis down, koneksi ditolak (fail-closed)
- Pastikan Nginx meneruskan WebSocket upgrade headers:
  ```nginx
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection 'upgrade';
  ```
- Jika timeout: cek `proxy_read_timeout` di Nginx (harus ≥ 60s untuk WebSocket)

### 19.9 Startup Gagal: "Environment validation failed"

Env validation (`src/config/env.validation.ts`) mencetak semua error sekaligus:
```
Environment validation failed — fix the following variables before starting:
  • DATABASE_URL: DATABASE_URL is required but missing or empty
  • AES_SECRET_KEY: AES_SECRET_KEY must be at least 64 hex characters
```

**Solusi:** Fix semua variable yang dilaporkan. Minimum length **64 karakter** untuk 5 JWT secret, `AES_SECRET_KEY`, `HMAC_SECRET_KEY`, `AES_KDF_SALT`, dan `WALLET_PIN_PEPPER` (`MIN_SECRET_LENGTH` di `src/main.ts`). `openssl rand -hex 32` menghasilkan tepat 64 karakter — pakai itu, jangan `-base64 32` (cuma 44).

### 19.10 Reconciliation Discrepancy Ditemukan

Jika weekly reconciliation menemukan discrepancy (`clean: false`):

1. Cek PM2 log untuk detail wallet yang bermasalah
2. Jalankan reconciliasi manual via admin API:
   ```bash
   curl -X POST https://api.kahade.id/v1/admin/finance/reconcile/user/USER_ID \
     -H "Authorization: Bearer ADMIN_JWT"
   ```
3. Jika `invariantViolation: true` (available + escrow ≠ total), **jangan auto-fix** — investigasi manual diperlukan
4. Cek audit trail: `GET /v1/admin/finance/audit-trail/USER_ID?from=YYYY-MM-DD&to=YYYY-MM-DD`

---

## 20. Quick Reference Cheatsheet

```
╔══════════════════════════════════════════════════════════════╗
║             KAHADE BACKEND — COMMAND CHEATSHEET              ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  APP (sebagai user kahade)                                   ║
║  ─────────────────────────────────────────────               ║
║  pm2 start kahade-api             Start                      ║
║  pm2 stop kahade-api              Stop                       ║
║  pm2 restart kahade-api           Hard restart                ║
║  pm2 restart kahade-api           Restart proses aktif       ║
║  pm2 status                       Process table              ║
║  pm2 monit                        Real-time dashboard        ║
║                                                              ║
║  LOGS                                                        ║
║  ─────────────────────────────────────────────               ║
║  pm2 logs kahade-api              Live tail                  ║
║  pm2 logs kahade-api --err        Error only                 ║
║  pm2 logs kahade-api -l 500       Last 500 lines             ║
║                                                              ║
║  DEPLOY                                                      ║
║  ─────────────────────────────────────────────               ║
║  cd /var/www/kahade/apps/backend && ./deploy.sh                    ║
║                                                              ║
║  SSL                                                         ║
║  ─────────────────────────────────────────────               ║
║  sudo certbot renew --dry-run     Test renewal               ║
║  sudo certbot renew               Force renewal              ║
║  sudo certbot certificates        List certificates          ║
║                                                              ║
║  NGINX                                                       ║
║  ─────────────────────────────────────────────               ║
║  sudo nginx -t                    Test config                ║
║  sudo systemctl reload nginx      Reload                     ║
║  sudo tail -f /var/log/nginx/error.log   Error log           ║
║                                                              ║
║  DATABASE                                                    ║
║  ─────────────────────────────────────────────               ║
║  psql -U kahade_prod -d kahade_prod -h 127.0.0.1             ║
║  pnpm exec prisma migrate deploy  Run migrations             ║
║  bash scripts/run-constraints.sh  Apply constraints          ║
║                                                              ║
║  REDIS                                                       ║
║  ─────────────────────────────────────────────               ║
║  redis-cli -a PASSWORD ping       Test connection            ║
║  redis-cli -a PASSWORD info memory   Memory usage            ║
║  sudo systemctl restart redis-server   Restart               ║
║                                                              ║
║  BACKUP                                                      ║
║  ─────────────────────────────────────────────               ║
║  ~/backup-db.sh                   Manual backup              ║
║  ls -lh /var/backups/kahade/      List backups               ║
║                                                              ║
║  MONITORING                                                  ║
║  ─────────────────────────────────────────────               ║
║  curl -s localhost:3000/v1/health | jq .   Health check      ║
║  sudo fail2ban-client status      Fail2ban                   ║
║  sudo ufw status                  Firewall                   ║
║  htop                             System resources           ║
║  df -h                            Disk usage                 ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
```
