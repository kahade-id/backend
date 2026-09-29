# Integrasi DANA Enterprise (Gapura) — Sandbox

**Branch:** `migrasi-dana/integrasi`
**Tanggal:** 29 September 2026
**Status:** Diimplementasikan + unit test lolos + push. **BELUM sandbox-proven** (kredensial sandbox belum ada), BELUM merge, BELUM deploy.

Keputusan produk 2026-09-29: DANA Enterprise = **provider UTAMA** uang masuk/keluar Kahade.
Flash Mobile = plan B (branch `migrasi-flash/integrasi` terpisah, tidak disentuh).

---

## 1. Endpoint mapping (resmi, dari docs dashboard + SDK `dana-python`)

### Payment Gateway (SNAP service code 54)

| Operasi | Method + Path |
|---|---|
| Create Order (QRIS / VA / Balance) | `POST /payment-gateway/v1.0/debit/payment-host-to-host.htm` |
| Query Payment | `POST /payment-gateway/v1.0/debit/status.htm` |
| Refund | `POST /payment-gateway/v1.0/debit/refund.htm` |
| Cancel | `POST /payment-gateway/v1.0/debit/cancel.htm` |
| Finish-notify webhook | `POST /v1/webhooks/dana/payment` (didaftarkan di dashboard DANA) |

**Mapping kanal bayar (Create Order):**
- **QRIS** → `payMethod=NETWORK_PAY`, `payOption=NETWORK_PAY_PG_QRIS`, `externalStoreId` WAJIB, `partnerReferenceNo` maks 25 char, `validUpTo` maks 30 menit (sandbox), `additionalInfo.order.scenario=API`. Respons = `paymentCode` (string QR), bukan checkout URL.
- **Virtual Account** → `payMethod=VIRTUAL_ACCOUNT`, `payOption=VIRTUAL_ACCOUNT_<BANK>` (cth: `VIRTUAL_ACCOUNT_CIMB`, `VIRTUAL_ACCOUNT_BRI`). DANA auto-generate payment code.
- **DANA Balance** → `payMethod=BALANCE`.
- Idempotency sisi DANA: `merchantId + partnerReferenceNo`.
- Base URL: sandbox `http://api.sandbox.dana.id`, production `https://api.saas.dana.id`. SNAP channel ID: `95221`.

### Disbursement

| Operasi | Method + Path |
|---|---|
| Transfer ke bank | `POST /v1.0/emoney/transfer-bank.htm` |
| Status transfer bank | `POST /v1.0/emoney/transfer-bank-status.htm` |
| Transfer ke akun DANA | `POST /rest/v1.0/emoney/topup` |
| Status transfer ke DANA | `POST /rest/v1.0/emoney/topup-status` |
| Bank account inquiry (verifikasi rekening) | `POST /v1.0/emoney/bank-account-inquiry.htm` |
| DANA account inquiry | `POST /rest/v1.0/emoney/account-inquiry` |

`fundType` resmi fixture: `MERCHANT_WITHDRAW_FOR_CORPORATE` (transfer ke bank + inquiry).

### Status transaksi (`latestTransactionStatus`)
`00`=Success · `01`=Initiated · `02`=Paying · `05`=Cancelled · `07`=Not found.

---

## 2. Environment variables (placeholder saja — TANPA nilai asli)

```
DANA_PARTNER_ID=
DANA_PRIVATE_KEY=            # RSA PKCS#8, baris \n boleh escaped
DANA_PUBLIC_KEY=             # kunci publik webhook (opsional; sandbox pakai bawaan SDK resmi)
DANA_ENV=sandbox
DANA_API_BASE_URL=http://api.sandbox.dana.id
DANA_MERCHANT_ID=
DANA_ORIGIN=https://kahade.id
DANA_CHANNEL_ID=95221
DANA_EXTERNAL_STORE_ID=      # WAJIB untuk QRIS
DANA_WEBHOOK_URL=https://api.kahade.id/v1/webhooks/dana/payment
DANA_DEBUG=true
DANA_ORDER_EXPIRY_MINUTES=30
```

Tanpa kredensial → semua operasi **fail-closed** (`DANA_NOT_CONFIGURED`), boot tetap jalan.

---

## 3. Keamanan webhook (fail-closed)

`POST /v1/webhooks/dana/payment`:
1. Verifikasi signature RSA-SHA256 DANA atas **raw body** (`X-SIGNATURE`/`X-TIMESTAMP`) — invalid → **403**, tidak diproses.
2. Durable inbox `webhookLog` (`eventKey = DANA:<referenceNo>:<status>`) — retry/duplikat DANA idempoten.
3. Lookup `PaymentTransaction.danaPartnerReferenceNo`. Tak dikenal (notify uji portal) → catat + ack **tanpa settlement**.
4. **Verify-via-API**: `QueryPayment` harus `SUCCESS` dan nominal == `grossAmount` — selain itu **JANGAN kredit**.
5. Settlement memakai jalur yang sama dengan provider lain: `WalletService.handleTopupSuccess` (TOPUP), `OrderQrisPaymentService.handleSettlement` (ORDER_ESCROW). Tidak ada logika finansial baru.
6. Selalu balas 200 untuk outcome bisnis (anti retry-storm); 4xx/5xx hanya untuk signature invalid / infra gagal.

---

## 4. Skenario mandatory portal DANA (nama persis, dari `resource/mandatory-tests.json`)

**Payment Gateway — 8 skenario:**
1. `TestCreateOrderRedirectScenario`
2. `TestCreateOrderInvalidFieldFormat`
3. `TestCreateOrderInconsistentRequest`
4. `TestCreateOrderInvalidMandatoryField`
5. `TestCreateOrderUnauthorized`
6. `TestTransactionSuccessNotify`
7. `TestInternalServerErrorNotify`
8. `TestExpiredNotify`

**Disbursement — 17 skenario:**
- TopUp customer (7): `TestTopUpCustomerValid`, `TestTopUpCustomerInsufficientFund`, `TestTopUpCustomerFrozenAccount`, `TestTopUpCustomerMissingMandatoryField`, `TestTopUpCustomerInconsistentRequest`, `TestTopUpCustomerInternalServerError`, `TestTopUpCustomerInternalGeneralError`
- Disbursement bank (7): `TestDisbursementBankValidAccount`, `TestDisbursementBankValidAccountInProgress`, `TestDisbursementBankInconsistentRequest`, `TestDisbursementBankInsufficientFund`, `TestDisbursementBankInactiveAccount`, `TestDisbursementBankInvalidFieldFormat`, `TestDisbursementBankMissingMandatoryField`
- Finish notify (3): `TestTransactionSuccessNotify`, `TestInternalServerErrorNotify`, `TestExpiredNotify`

Webhook kita dirancang lolos sisi penerima notify (verifikasi signature + ack 200 untuk notify uji portal tanpa settlement).

---

## 5. File yang dibuat/diubah

**Baru:**
- `src/config/dana.config.ts` — config namespace `dana` (placeholder, fail-closed)
- `src/modules/payment/dana/dana.module.ts` — `DanaModule`
- `src/modules/payment/dana/dana.types.ts` — tipe Create Order / webhook / disbursement
- `src/modules/payment/dana/dana-snap.util.ts` — SNAP signing + verifikasi webhook (RSA-SHA256, timestamp Jakarta)
- `src/modules/payment/dana/dana-snap.util.spec.ts` — 13 test
- `src/modules/payment/dana/dana-payment.service.ts` — Create Order QRIS/VA/Balance, Query, Refund, Cancel
- `src/modules/payment/dana/dana-payment.service.spec.ts` — 11 test
- `src/modules/payment/dana/dana-disbursement.service.ts` — transfer bank/DANA, inquiry rekening, inquiry status
- `src/modules/payment/dana/dana-disbursement.service.spec.ts` — 6 test
- `src/modules/webhooks/dana-webhook.controller.ts` — `POST /v1/webhooks/dana/payment`
- `src/modules/webhooks/dana-webhook-settlement.service.ts` — verifikasi + idempotency + settlement
- `src/modules/webhooks/dana-webhook-settlement.service.spec.ts` — 6 test (idempotency, fail-closed)
- `prisma/migrations/20261011000000_dana_provider/migration.sql` — additive-only
- `docs/dana-integration.md` — dokumen ini

**Diubah:**
- `prisma/schema.prisma` — `PaymentProvider.DANA`, kolom `danaPartnerReferenceNo` (@unique), `danaReferenceNo`
- `src/config/index.ts` — export `danaConfig`
- `src/app.module.ts` — load `danaConfig` di `ConfigModule`
- `src/modules/payment/payment.module.ts` — import + re-export `DanaModule`
- `src/modules/webhooks/webhooks.module.ts` — controller + settlement DANA

---

## 6. Validasi (29 Sep 2026)

- ✅ 36 unit test lolos (signature, create-order mapping, disbursement mapping, idempotency webhook, fail-closed)
- ✅ `npx tsc --noEmit` — 0 error
- ✅ `prisma validate` — schema valid; `prisma generate` OK
- ✅ DI smoke test modul DANA — `enabled=false` tanpa kredensial (fail-closed benar)
- ❌ **Belum**: sandbox E2E (butuh `DANA_PARTNER_ID` + RSA private key), skenario mandatory portal, migrasi DB di-apply di server

## 7. Yang BELUM dilakukan / butuh tindak lanjut

1. Isi kredensial sandbox di `.env` server (bukan di repo), lalu jalankan 8+17 skenario mandatory di portal DANA.
2. Daftarkan webhook URL `https://api.kahade.id/v1/webhooks/dana/payment` di dashboard DANA (tipe NOTIFICATION).
3. Apply migrasi `20261011000000_dana_provider` saat deploy.
4. Integrasikan `DanaPaymentService.createOrder` ke alur `PaymentService` (top-up QRIS/VA + bayar escrow QRIS) — wiring bisnis, belum dikerjakan.
5. Integrasikan `DanaDisbursementService` ke alur withdrawal (pengganti Iris) — ditunda sesuai keputusan (fokus uang masuk dulu).
6. Timestamp tolerance (anti-replay) webhook — saat ini mengandalkan inbox idempotency; bisa ditambah batas ±5 menit.
