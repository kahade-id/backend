# Partner API — Definisi Produk (G451)

> Dokumen internal/keputusan produk untuk Kahade Public Partner API & outbound webhooks.
> Bahasa: Indonesia. Versi payload webhook saat ini: `1.0` (lihat `docs/partner-webhook-changelog.md`).

## 1. Ringkasan produk

Kahade menyediakan API publik berbasis API key untuk **mitra bisnis terverifikasi**
(merchant, agregator logistik, layanan integrasi) agar dapat membaca status transaksi
miliknya sendiri dan menerima notifikasi event bisnis via webhook keluar (*outbound*,
server Kahade → server mitra).

API ini adalah **lapisan baca + notifikasi**, bukan lapisan transaksi:
mitra **tidak bisa** membuat pembayaran, menarik dana, mengubah order, atau
mengakses data pengguna lain melalui API ini.

## 2. Whitelist data yang boleh diakses mitra

Mitra hanya mendapat data milik client-nya sendiri (terikat `clientId` pada API key),
dengan field yang dibatasi (*whitelisted*):

- **Orders (scope `orders:read`)**: `publicId`, `status`, `items` (nama, qty, harga satuan),
  `totalAmount`, `createdAt`, `completedAt`.
- **Payments (scope `payments:read`)**: `paymentId`, `status`, `amount`, `paidAt`.
- **Webhook subscriptions (scope `webhooks:read`/`webhooks:manage`)**: daftar endpoint
  milik sendiri, status verifikasi, dan riwayat pengiriman (*tereduksi*, lihat §5).

Field di luar daftar ini **tidak di-serialize** oleh `PartnerApiService` — lapisan
presentasi selalu memetakan ulang record DB ke DTO whitelist, tidak pernah melempar
entity Prisma mentah.

## 3. LARANGAN keras (non-negotiable)

1. **Tidak ada PII pihak lain**: API tidak pernah mengembalikan nama lengkap,
   alamat, nomor HP, email, NIK, atau data KYC pengguna mana pun. Yang tampil
   hanya data transaksi milik client mitra itu sendiri.
2. **Tidak ada PIN, password, OTP, atau secret**: tidak ada endpoint yang
   mengembalikan atau menerima kredensial pengguna. API key mitra sendiri hanya
   tampil sekali saat diterbitkan/dirotasi (G453) dan tidak pernah disimpan
   dalam bentuk plaintext.
3. **Tidak ada saldo pihak lain**: API tidak mengekspos saldo wallet siapa pun —
   termasuk wallet mitra sendiri. Saldo hanya dapat dilihat melalui aplikasi
   Kahade resmi dengan autentikasi penuh (JWT + PIN).
4. **Tidak ada mutasi uang**: tidak ada endpoint `POST /payments`, `POST /withdraw`,
   atau sejenisnya di namespace `/v1/partner/*`. Semua mutasi dana tetap melalui
   alur escrow resmi aplikasi.
5. **Tidak ada akses lintas client**: setiap API key terikat satu `ApiClient`.
   Guard menolak request yang mencoba membaca data di luar client key tersebut.
6. **Tidak ada akses data produksi dari key sandbox** (G458): key `kh_sandbox_*`
   hanya berlaku di `/v1/partner-sandbox/*` (data sintetis), dan key `kh_live_*`
   hanya di `/v1/partner/*`. Penukaran lingkungan ditolak di `PartnerApiKeyGuard`.

## 4. Model kepercayaan

| Aktor | Tanggung jawab |
|---|---|
| Kahade (platform) | Menerbitkan/mencabut key, menegakkan scope, rate limit, kuota, menandatangani webhook (HMAC-SHA256), retry + DLQ, audit trail setiap aksi admin. |
| Admin (SUPER_ADMIN) | Onboarding client, mengatur scope & limit, revoke instan. Tidak pernah melihat plaintext key setelah diterbitkan. |
| Mitra | Menyimpan API key & webhook secret dengan aman (vault/KMS), memverifikasi signature setiap webhook, menolak replay (event ID unik + jendela 5 menit), menjaga endpoint HTTPS-nya sendiri. |

## 5. Reduksi data di portal & log

- Secret webhook disimpan terenkripsi AES-GCM (`secretEnc`) — tidak pernah
  di-return oleh endpoint admin maupun partner.
- Delivery log menampilkan `lastError` yang sudah diredaksi (tanpa body respons
  dari server mitra) dan `responseCode` saja (G468).
- Audit log (`PartnerAuditLog`) mencatat setiap aksi: `CLIENT_CREATED`,
  `KEY_ISSUED`, `KEY_ROTATED`, `KEY_REVOKED`, `ENDPOINT_CREATED`, `ENDPOINT_VERIFIED`,
  `ENDPOINT_DELETED`, `DELIVERY_REPLAYED`, beserta admin pelaksana dan IP.

## 6. Siklus hidup client

`ACTIVE` → `SUSPENDED` (pelanggaran ringan / investigasi, akses diblokir sementara)
→ `REVOKED` (penghapusan permanen akses; key ikut tidak valid). Penghapusan client
menghapus cascade key, endpoint, delivery, dan usage (lihat kontrak keamanan
`docs/partner-security-contract.md` § penghapusan client).

## 7. Referensi

- Kontrak keamanan: `docs/partner-security-contract.md`
- Referensi API v1 (ID): `docs/partner-api-v1.md` · (EN): `docs/partner-api-v1.en.md`
- Changelog payload webhook: `docs/partner-webhook-changelog.md`
