# Partner API v1 — Referensi (Bahasa Indonesia)

Base URL: `https://api.kahade.id/v1` · Versi payload webhook: `1.0`
Dokumen pendamping (EN): `docs/partner-api-v1.en.md`.

## Autentikasi

Semua endpoint `/v1/partner/*` memakai **API key** (bukan JWT pengguna).

- Header: `X-API-Key: kh_live_...` (atau skema `Authorization: ApiKey kh_live_...`).
- Format key: `kh_live_<32 byte base64url>` untuk produksi,
  `kh_sandbox_<32 byte base64url>` untuk sandbox.
- Key **hanya ditampilkan sekali** saat diterbitkan/dirotasi oleh admin.
  Simpan di secret manager; Kahade tidak bisa menampilkannya ulang.

### Scope granular

Setiap key membawa daftar scope. Endpoint menolak dengan `403` bila scope kurang.

| Scope | Akses |
|---|---|
| `orders:read` | `GET /v1/partner/orders/:publicId` |
| `payments:read` | Endpoint pembayaran milik client (bila diaktifkan) |
| `webhooks:read` | `GET /v1/partner/webhooks/health` |
| `webhooks:manage` | Registrasi endpoint & `POST /v1/partner/webhooks/verify-challenge` |

## Rate limit & kuota

- Rate limit per client + endpoint: default **100 req/menit** (dapat diubah admin
  per client via `rateLimitPerMinute`). Kelebihan → `429` dengan header `Retry-After`.
- Kuota harian: default **10.000 req/hari** per client (`quotaPerDay`).
- Pemakaian tercatat harian per endpoint (`PartnerApiUsage`); admin dapat
  memantau dari portal tanpa melihat secret.

## Sandbox

- Key sandbox **hanya** berlaku di `/v1/partner-sandbox/*` — data 100% sintetis,
  tidak pernah menyentuh saldo/data produksi.
- Key produksi **hanya** di `/v1/partner/*`. Penukaran lingkungan ditolak (`401`).

## Endpoint

### GET /v1/partner/orders/:publicId
Scope: `orders:read`. Detail order milik client (field whitelist, tanpa PII).

```json
{
  "publicId": "ORD-9X2KQ",
  "status": "COMPLETED",
  "items": [{ "name": "Kopi Arabika 250g", "qty": 2, "unitPrice": 75000 }],
  "totalAmount": 150000,
  "createdAt": "2026-09-20T10:00:00.000Z",
  "completedAt": "2026-09-22T14:30:00.000Z"
}
```

### GET /v1/partner/webhooks/health
Scope: `webhooks:read`. Status langganan webhook milik client: daftar endpoint,
event yang disubscribe, `isActive`, `lastDeliveryStatus`.

### POST /v1/partner/webhooks/verify-challenge
Scope: `webhooks:manage`. Body: `{ "endpointId": "...", "challenge": "<token>" }`.
Meng-echo token challenge yang dikirim Kahade ke URL endpoint saat registrasi.
Berhasil → endpoint `isActive=true` dan mulai menerima event.

## Webhook keluar (Kahade → mitra)

### Registrasi
Endpoint didaftarkan via portal admin (SUPER_ADMIN). Aturan URL (anti-SSRF):
HTTPS saja, port 443, tanpa kredensial di URL, dan hostname/IP tidak boleh
termasuk rentang private/reserved/loopback/link-local/multicast/metadata cloud
(`127.0.0.1`, `10.0.0.0/8`, `169.254.169.254`, dsb. — resolve DNS lalu cek semua IP).
Jika `PARTNER_EGRESS_ALLOWLIST` diset, hanya CIDR dalam daftar yang diizinkan.

### Verifikasi kepemilikan
Saat endpoint dibuat, Kahade mengirim `POST` berisi `webhook.challenge` dengan
`challengeToken` acak. Mitra meng-echo token via `verify-challenge` di atas.
Endpoint **tidak aktif** sebelum verifikasi berhasil.

### Format pengiriman
Header setiap delivery:

| Header | Isi |
|---|---|
| `X-Kahade-Signature` | HMAC-SHA256 hex dari `timestamp.eventId.body` memakai secret endpoint |
| `X-Kahade-Timestamp` | epoch millis saat pengiriman |
| `X-Kahade-Event-Id` | UUID unik per event (idempotency key) |

Body (JSON, `version: "1.0"`):

```json
{
  "version": "1.0",
  "eventId": "evt_01J...",
  "eventType": "order.completed",
  "occurredAt": "2026-09-26T13:00:00.000Z",
  "data": { "publicId": "ORD-9X2KQ", "status": "COMPLETED", "totalAmount": 150000 }
}
```

### Verifikasi signature (pseudocode)

```
expected = HMAC_SHA256(secret, timestamp + "." + eventId + "." + rawBody)
if !constantTimeEqual(expected, header("X-Kahade-Signature")): reject
if abs(now - timestamp) > 5 menit: reject          // anti-replay
if eventId sudah pernah diproses: skip (idempoten) // anti-replay
```

### Event yang tersedia

`order.completed`, `payment.received`, `payout.completed`,
`subscription.activated`, `webhook.test` (uji manual), `webhook.challenge`.

### Retry & DLQ
Kegagalan (non-2xx / timeout 60 dtk) dijadwalkan ulang dengan backoff
eksponensial: **1 mnt → 5 mnt → 15 mnt → 1 jam → 6 jam**, lalu masuk
**DLQ** setelah 6 percobaan. Admin dapat me-replay manual dari portal —
replay memakai `eventId` yang sama sehingga idempoten di sisi penerima.

## Kode error umum

| Kode | Arti |
|---|---|
| `401` | API key hilang/tidak valid/kedaluwarsa/di-revoke, atau lingkungan salah |
| `403` | Scope tidak mencukupi, atau client di-suspend |
| `404` | Resource tidak ada / bukan milik client |
| `429` | Rate limit / kuota terlampaui (`Retry-After` dalam detik) |

Lihat juga: `docs/partner-api-product.md` (definisi produk),
`docs/partner-security-contract.md` (kontrak keamanan & anti-replay),
`docs/partner-webhook-changelog.md` (versioning payload).
