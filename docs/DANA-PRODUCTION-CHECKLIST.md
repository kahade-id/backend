# Checklist Go-Live DANA Enterprise (Production)

Dokumen ini menjelaskan **persis** apa yang harus disiapkan agar backend Kahade
berpindah dari DANA Sandbox ke DANA Production. Prinsip: pindah mode =
**`DANA_ENV=production` + kredensial produksi, tanpa perubahan kode.**

> **Tidak ada secret/nilai kredensial di dokumen ini** — hanya format dan dari
> mana mendapatkannya. Secret hanya hidup di `/var/www/kahade/apps/backend/.env`
> (server production), tidak di Git.

---

## 1. Switch environment (satu-satunya perubahan yang dibutuhkan)

| Variabel | Sandbox | Production |
|---|---|---|
| `DANA_ENV` | `sandbox` (default) | `production` |
| Base URL otomatis | `http://api.sandbox.dana.id` | `https://api.saas.dana.id` |
| X-DEBUG | `true` (default non-production) | `false` (kecuali diset eksplisit) |

`src/config/dana.config.ts` memilih base URL otomatis dari `DANA_ENV`.
`DANA_API_BASE_URL` hanya diisi bila perlu override (jangan diisi normalnya).

---

## 2. Environment variables produksi (format persis)

Semua nilai didapat dari **DANA dashboard** (https://dashboard.dana.id) setelah
akun production disetujui. Format mengikuti konvensi sandbox yang sudah jalan.

| Variabel | Format | Wajib | Keterangan |
|---|---|---|---|
| `DANA_ENV` | `production` | Ya | Switch mode |
| `DANA_PARTNER_ID` | string, mis. `2029...` (Partner ID dari dashboard) | Ya | Header X-PARTNER-ID; juga dipakai validasi webhook disbursement |
| `DANA_PRIVATE_KEY` | PEM RSA PKCS#8 multi-baris, diawali `-----BEGIN PRIVATE KEY-----` | Ya | Private key production milik Kahade (generate sendiri, upload public key-nya ke dashboard) |
| `DANA_MERCHANT_ID` | string (Merchant ID dari dashboard) | Ya | |
| `DANA_PUBLIC_KEY` | PEM RSA, diawali `-----BEGIN PUBLIC KEY-----` | Ya | **Public key DANA production** untuk verifikasi signature webhook (sandbox memakai kunci bawaan SDK; production WAJIB diisi dari dashboard) |
| `DANA_CHANNEL_ID` | `95221` | Ya | CHANNEL-ID (nilai dari SDK resmi; sama untuk production) |
| `DANA_EXTERNAL_STORE_ID` | string (External Store ID dari dashboard) | Ya untuk QRIS | **WAJIB bila QRIS dipakai** — payOption QRIS menolak order tanpa ini. Masih kosong per 2026-09-30 → QRIS production tidak akan jalan sampai diisi |
| `DANA_ORIGIN` | `https://kahade.id` | Tidak | Default sudah benar; isi eksplisit bila domain berubah |
| `DANA_WEBHOOK_URL` | `https://api.kahade.id/v1/webhooks/dana/payment` | Tidak | Default sudah benar |
| `DANA_ORDER_EXPIRY_MINUTES` | angka, mis. `30` | Tidak | Masa berlaku order QRIS/VA (menit); default 30 |
| `DANA_DEBUG` | `true`/`false` | Tidak | Default `false` di production |
| `DANA_API_BASE_URL` | URL | Tidak | Jangan diisi (override darurat saja) |

**Catatan multi-baris PEM di .env:** simpan private/public key sebagai satu
baris dengan `\n` literal BILA loader .env mendukungnya, atau gunakan file
terpisah yang dibaca saat deploy — ikuti pola yang sudah dipakai kredensial
sandbox di server (jangan ubah pola hanya untuk production).

**Fail-closed:** bila `DANA_PARTNER_ID` / `DANA_PRIVATE_KEY` / `DANA_MERCHANT_ID`
kosong, layanan DANA berjalan degraded (log warn, semua pemanggilan DANA
menolak). Bila `DANA_PUBLIC_KEY` kosong di production → **webhook tidak bisa
diverifikasi → semua notify ditolak** (by design, jangan bypass).

---

## 3. Konfigurasi di DANA dashboard (production)

- [ ] Upload **public key production** Kahade (pasangan dari `DANA_PRIVATE_KEY`).
- [ ] Catat **Partner ID**, **Merchant ID**, **Public Key DANA production**,
      **External Store ID** (untuk QRIS) ke `.env` server.
- [ ] Daftarkan webhook URL (sudah didaftarkan saat submission 2026-09-30;
      verifikasi ulang nilainya di production):
  - Finish Payment URL → `https://api.kahade.id/v1/webhooks/dana/payment`
  - Disbursement Notify URL → `https://api.kahade.id/v1/webhooks/dana/disbursement`
  - Finish Redirect URL → `https://kahade.id/payment/finish`
- [ ] Pastikan endpoint `/v1/webhooks/dana/disbursement` **sudah ter-deploy**
      di server production SEBELUM go-live (URL sudah didaftarkan — notify
      DANA akan 404/5xx bila kode belum live).
- [ ] Jalankan migrasi `20260930150000_dana_disbursement_needs_review`
      (additive-only: tambah enum `NEEDS_REVIEW`) sebelum/saat deploy.

---

## 4. Verifikasi pra-go-live (di production, tanpa uang sungguhan dulu)

- [ ] `DANA_ENV=production` + kredensial terisi → boot tanpa warn DANA.
- [ ] `GET /v1/health` → `{status:"ok"}` (tidak membocorkan detail).
- [ ] **Bank Account Inquiry** dengan rekening uji → nama pemilik kembali benar.
- [ ] Buat order kecil (nominal minimum) via QRIS/VA → bayar → pastikan
      finish-notify 200 + status payment SETTLED + webhookLog processed.
- [ ] Refund order uji → pastikan dana kembali (cek dashboard DANA).
- [ ] Disbursement kecil ke rekening uji → pastikan notify disbursement 200 +
      `EscrowDisbursement.status = SUCCESS`.
- [ ] Simulasi header webhook salah (X-PARTNER-ID beda) → 403 (bukti binding
      merchant aktif).
- [ ] Kirim notify dengan `latestTransactionStatus` fiktif (mis. `99`) ke
      endpoint staging → `EscrowDisbursement.status = NEEDS_REVIEW`
      (bukti status tak dikenal tidak otomatis FAILED).
- [ ] `GET /v1/legacy-payout/disbursements?scope=CASHBACK` sebagai user uji →
      `200 { items: [...] }`.

---

## 5. Yang sudah diperkuat di branch ini (siap production)

1. Webhook disbursement memvalidasi `X-PARTNER-ID` (harus = `DANA_PARTNER_ID`),
   `X-EXTERNAL-ID` (wajib ada), dan `CHANNEL-ID` (harus = `DANA_CHANNEL_ID`) —
   fail-closed 403 bila tidak cocok.
2. Respons webhook menyertakan header `X-TIMESTAMP` (konvensi DANA).
3. Kompatibilitas signature Transfer to Bank Notify dibuktikan dengan vektor
   resmi SDK `dana-python` (test deterministik, bukan round-trip sendiri).
4. Status DANA di luar `00–07` → `EscrowDisbursementStatus.NEEDS_REVIEW`
   (review manual), bukan otomatis FAILED.
5. Kegagalan `applyStatus()` → webhook TIDAK ditandai processed, error
   dicatat, respons 5xx agar DANA retry (sebelumnya ditandai processed =
   update hilang diam-diam).
6. DI wiring webhook module terverifikasi via compile test.
7. Status cashback/referral/escrow terekspos di
   `GET /v1/legacy-payout/disbursements?scope=...` + test kontrak.

## 6. Rollback

- Rilis production sebelumnya tetap tersedia sebagai
  `/var/www/kahade-release-<SHA>` — flip symlink `kahade-current` kembali
  bila verifikasi §4 gagal.
- Migrasi `NEEDS_REVIEW` additive-only: rollback kode aman tanpa rollback DB
  (enum value yang tak terpakai tidak merusak kode lama).

---

_Diperbarui: 2026-09-30. Pemilik: tim backend money-flow (`integrasi/dana-moneyflow-be`)._
