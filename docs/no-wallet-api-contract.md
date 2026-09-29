# Kontrak API — Mode Tanpa Wallet Internal (BI-safe)

> Branch: `arsitektur/tanpa-wallet`. Dokumen kanonis untuk tim frontend.
> Semua endpoint di bawah memakai prefix `/v1`.

## Prinsip

- `GET /v1/public/wallet-status` → `{ walletEnabled: boolean }` (tanpa auth).
  - `false` (default, fail-closed): SEMUA alur uang via DANA langsung.
    Wallet internal mati: tidak ada top-up, tidak ada debit/kredit wallet.
  - `true`: perilaku lama (wallet) — hanya bila BI mengizinkan.
- Aliran uang mode BI-safe: **buyer → DANA → escrow → rekening bank seller**.
  Escrow "pot"-nya adalah `PaymentTransaction` (DANA, SUCCESS); pencairan via
  DANA Disbursement ke rekening bank seller yang **terverifikasi**.
- Seller WAJIB punya rekening bank terverifikasi (bank inquiry + name-match)
  sebelum menerima payout APAPUN (escrow release, milestone, cashback,
  referral). Tanpa itu → `HELD_NO_BANK` (fail-closed, dana tidak hangus,
  seller dinotifikasi).
- Semua refund → **DANA Refund API ke metode bayar asal** (penuh & parsial),
  idempoten via `idempotencyKey` (satu refund per key; DANA idempoten per
  `partnerRefundNo`).
- Semua payout/disbursement → idempoten via `idempotencyKey` stabil
  (`ORDER:<id>`, `MILESTONE:<id>`, `CASHBACK:<id>`, `REFERRAL:<id>`,
  `DISPUTE:<id>:BUYER|SELLER`).

## Endpoint kanonis

### 1. `GET /v1/public/wallet-status` (tanpa auth)

Response:
```json
{ "walletEnabled": false }
```

### 2. `GET /v1/orders/:id/payment-methods` (auth: buyer order itu)

Daftar metode bayar DANA yang didukung — **frontend render apa adanya,
jangan hardcode QRIS saja**.

Response:
```json
{
  "walletEnabled": false,
  "methods": [
    { "kind": "QRIS", "label": "QRIS", "requiresBankCode": false },
    { "kind": "VA", "label": "Virtual Account", "requiresBankCode": true,
      "banks": ["BCA", "BNI", "BRI", "MANDIRI", "CIMB", "PERMATA"] },
    { "kind": "BALANCE", "label": "Saldo DANA", "requiresBankCode": false }
  ]
}
```

### 3. `POST /v1/orders/:id/payments` (auth: buyer, Idempotency-Key didukung)

Buat pembayaran DANA untuk order. Idempoten per order: charge PENDING yang
masih berlaku dikembalikan ulang (tidak ada charge ganda).

Request:
```json
{ "payKind": "QRIS" }
{ "payKind": "VA", "bankCode": "BCA" }
{ "payKind": "BALANCE" }
```

Response (200):
```json
{
  "paymentTxId": "PAY-...",
  "orderId": "ORD-...",
  "status": "PENDING",
  "payKind": "QRIS",
  "escrowAmount": 150000,
  "providerFee": 1050,
  "grossAmount": 151050,
  "paymentCode": null,
  "qrString": "000201010212...",
  "webRedirectUrl": null,
  "expiryTime": "2026-09-29T15:30:00.000Z"
}
```
- `payKind=VA` → `paymentCode` = kode VA bank.
- `payKind=BALANCE` → `webRedirectUrl` = URL otorisasi DANA.
- Webhook DANA finish-notify → settlement: order → PROCESSING, escrow
  didanai TANPA lewat wallet. Frontend poll
  `GET /v1/orders/:id/dana-payment-status` atau `:id/status`.

Error codes: `DANA_VA_BANK_REQUIRED`, `ORDER_NOT_FOUND`,
`NOT_ORDER_PARTICIPANT`, `INVALID_ORDER_STATUS`, `ORDER_PAYMENT_EXPIRED`,
`DANA_NOT_CONFIGURED`, `DANA_API_ERROR`.

### 4. `POST /v1/legacy-payout` (auth + PIN wallet, Idempotency-Key)

Payout SATU ARAH saldo wallet lama → rekening bank user (program transisi;
bukan bagian escrow). PIN wajib, idempoten per `idempotencyKey`.

Request: `{ "amountIdr": 50000, "pin": "123456", "idempotencyKey": "uuid" }`
Response: `{ "payoutId": "...", "status": "PENDING|SUCCESS|HELD_NO_BANK", ... }`

### 5. Subscription Kahade+ (tanpa wallet)

- `POST /v1/subscriptions/subscribe-dana` — body:
  `{ plan: "MONTHLY"|"YEARLY", payKind: "QRIS"|"VA"|"BALANCE", bankCode?, promoCode? }`
  → subscription PENDING + data checkout DANA (`qrString` / `paymentCode` /
  `webRedirectUrl` + `expiredAt`). Webhook DANA finish-notify → ACTIVE.
  Gagal bayar → subscription tetap PENDING/EXPIRED (fail-closed, tidak aktif
  setengah jalan). Kode promo gratis / diskon 100% → tetap tanpa bayar
  (tanpa PIN, tanpa DANA). Idempoten via `Idempotency-Key` + guard PENDING.
- `GET /v1/subscriptions/dana-status/:id` — polling status (PENDING/ACTIVE)
  + sinkronisasi ringan ke DANA.
- `POST /v1/subscriptions/renew-dana` — body: `{ payKind, bankCode? }` →
  payment DANA renewal; periode diperpanjang webhook setelah bayar sukses.
- `POST /v1/subscriptions/subscribe-qris` (legacy Flash): saat wallet
  nonaktif otomatis didelegasikan ke DANA QRIS (tanpa PIN — PIN adalah
  konsep wallet).
- `POST /v1/subscriptions/subscribe` & `POST /v1/subscriptions/renew`
  (debit wallet): DITOLAK saat wallet nonaktif
  (`WALLET_DISABLED_USE_DANA`).
- Refund: admin force-cancel → payment DANA SUCCESS di-refund ke metode
  bayar asal via DANA Refund API (idempoten `ADMIN_SUB_CANCEL:<subId>`).

### 6. Refund & payout lain (tanpa wallet)

| Kejadian | Tujuan dana |
|---|---|
| Cancel / auto-cancel 2 hari | DANA Refund → metode bayar asal (penuh) |
| Dispute buyer menang / split | DANA Refund → buyer (porsi buyer); DANA Disbursement → rekening bank seller (porsi seller) |
| Retur disetujui | DANA Refund → metode bayar asal (penuh/parsial) |
| Milestone release | DANA Disbursement → rekening bank seller (per tahap) |
| Milestone dibatalkan | DANA Refund → metode bayar asal (parsial per tahap) |
| Cashback / referral | DANA Disbursement → rekening bank terverifikasi; belum ada rekening → PENDING fail-closed (tidak hangus, tidak ke wallet) |

Auto-refund patungan/jastip: sweep Bull tiap 5 menit
(`commerce-refund`) mengeksekusi refund DANA-direct untuk peserta
`REFUND_REQUIRED` — konsumen nyata, idempoten.

## Catatan idempotency & fail-closed

- Semua endpoint tulis uang mendukung header `Idempotency-Key` (atau
  idempoten alami per order/key stabil).
- Webhook DANA: verifikasi signature (path `/v1.0/debit/notify`),
  replay protection, verify-via-API + pencocokan nominal (fail-closed),
  ack `2005600`.
- Order bertahap (milestone): checkout SATU pembayaran DANA penuh
  (invariant `sum(buyerAmount) = buyerPayAmount` tetap); escrow per tahap
  (`escrowHeld`), release/disbursement per tahap ke bank seller, refund
  parsial per tahap ke sumber asal.
- Platform fee: tertahan di akun merchant DANA (tidak dicairkan ke seller).
  Seller menerima `sellerReceiveAmount`.
