# Kontrak API Baru — Audit 2026-10-03 (Backend)

Dokumen ini untuk tim Frontend dan tim Admin. Semua endpoint di bawah ini DIBUAT dalam
branch `fix/audit-2026-10-03-be`. Status: implementasi berjalan — kolom "Status"
akan diupdate koordinator setelah worker selesai & terverifikasi.

## 1. Step-up re-auth server-side (SEC-503, BAD-009)

Menggantikan re-auth yang selama ini hanya dialog di UI (bisa di-bypass via API langsung).

```
POST /v1/admin/auth/step-up
Auth: JWT admin
Body: { "password": "string", "action": "string", "targetId?": "string" }
→ 200 { "stepUpToken": "opaque", "expiresAt": "ISO-8601" }
→ 403 { code: "STEP_UP_BAD_PASSWORD" }
```

- Token: single-use, TTL 3 menit, terikat `action` (+ `targetId` bila diisi).
- Pemakaian: header `X-Step-Up-Token: <token>` pada endpoint yang mewajibkan.
- Validasi gagal → `403 STEP_UP_REQUIRED | STEP_UP_INVALID | STEP_UP_EXPIRED | STEP_UP_MISMATCH`.
- Contoh `action`: `dispute.resolve`, `insurance.review`, `insurance.pay`, `withdrawal.approve`,
  `withdrawal.reject`, `wallet.adjust`, `commerce.refund`, `order.cancelUnshipped`, `order.forceCancel`,
  `order.forceComplete`, `disbursement.reopen`, `admin.reset2fa`, `admin.resetPassword`,
  `admin.delete`, `admin.unlock`, `opsSetting.update`.

Endpoint yang kini WAJIB step-up (tanpa token → 403):
dispute resolve, insurance claim review (APPROVED/REJECTED/PAID), withdrawal approve/reject,
wallet adjust, commerce refund execute, disbursement reopen,
reset-2FA / reset-password / hapus / unlock admin,
PUT/DELETE ops-setting (semua key).

## 2. Dual control — persetujuan dua admin (SEC-501/502/601/602, BAD-001)

```
POST /v1/admin/approvals/propose
Auth: JWT admin + X-Step-Up-Token
Body: { "actionType": "DISPUTE_RESOLVE|INSURANCE_CLAIM_PAY|WALLET_ADJUST|COMMERCE_REFUND|DISBURSEMENT_REOPEN|OPS_SETTING_CHANGE",
        "targetId?": "string", "payload": {…}, "amountSen?": 12345,
        "idempotencyKey": "uuid" }
→ 200 { "approvalId": "…", "status": "PENDING", "expiresAt": "ISO-8601" }
(propose ulang dengan idempotencyKey sama → kembalikan record yang ada)

POST /v1/admin/approvals/:id/approve
Auth: JWT admin (≠ pengusul) + X-Step-Up-Token
→ 200 { "status": "EXECUTED" }
→ 403 { code: "SELF_APPROVAL" } bila decidedBy == proposedBy

POST /v1/admin/approvals/:id/reject
Body: { "reason?": "string" } → 200 { "status": "REJECTED" }

GET /v1/admin/approvals/pending → daftar menunggu persetujuan
```

Aturan ambang (dieksekusi langsung + step-up bila di bawah ambang):
- DISPUTE_RESOLVE: dual bila nominal > Rp1.000.000
- WALLET_ADJUST (CREDIT): dual bila > Rp1.000.000
- COMMERCE_REFUND: dual bila nominal escrow > Rp1.000.000
- INSURANCE_CLAIM_PAY: SELALU dual; `paidBy` wajib ≠ `approvedBy`
- DISBURSEMENT_REOPEN: SELALU dual (satu-satunya jalan me-revive CANCELLED)

```
POST /v1/admin/finance/disbursements/:id/reopen
Auth: SUPER_ADMIN + X-Step-Up-Token (action disbursement.reopen) + Idempotency-Key
→ 200 { "approvalId": "…", "status": "PENDING", "expiresAt": "…" }
   (eksekusi CANCELLED→PENDING oleh admin kedua via approve)
→ 409 { code: "DISBURSEMENT_NOT_REOPENABLE" } bila bukan CANCELLED
```

## 3. Disbursement — CANCELLED kini terminal (BAD-001)

`releaseFunds()` pada baris berstatus CANCELLED kini melempar `DISBURSEMENT_CANCELLED`
(tidak lagi retry/settle diam-diam).

```
POST /v1/admin/finance/disbursements/:id/reopen
Auth: SUPER_ADMIN (+ step-up; selalu via dual control §2)
→ 200 { "approvalId": "…" }  → setelah approve: status kembali PENDING + audit log
```

Catatan: route duplikat lama `GET /v1/admin/finance/disbursements` yang membocorkan
ciphertext rekening sudah dihapus — hanya varian kanonis yang tersisa.

## 4. Status pembayaran order untuk layar payment/finish (SEC-401)

```
GET /v1/orders/:orderId/payment-status
Auth: JWT user (hanya buyer/seller order tsb; selain itu 403)
→ 200 { "orderId": "…", "status": "PAID|PENDING|CANCELLED|EXPIRED|…", "paidAt?": "ISO-8601" }
```
`PAID` hanya bila pembayaran terverifikasi di server. Frontend WAJIB memanggil ini
sebelum merender status sukses (jangan percaya query params).

## 5. Like/dislike komentar showcase (BFE-117 / FAL-009)

```
POST /v1/showcase/comments/:commentId/like
Auth: JWT user
Body: { "value": 1 | -1 | 0 }   // 1=suka, -1=tidak suka, 0=hapus reaksi
→ 200 { "likes": 12, "dislikes": 1, "userVote": 1 | -1 | 0 }
```
Idempoten per user. Komentar yang di-hidden/soft-delete → 404/403.

Perubahan terkait:
- `GET` komentar kini memakai `replyCount` dari server (FE jangan hitung sendiri).
- Hapus komentar = soft-delete (`deletedAt/deletedBy/deleteReason`); balasan tetap ada.
- Kontrak cover kanonis: `coverMediaId` (lihat laporan worker).

## 6. Moderasi polling & komentar untuk admin (FAL-003, FAL-010)

```
GET  /v1/admin/chat/polls/:pollId
→ 200 { "poll": { "id": "…", "question": "…", "roomId": "…",
                  "options": [{ "id": "…", "text": "…", "voteCount": 3 }],
                  "totalVotes": 10, "isClosed": false,
                  "createdAt": "…", "createdBy": "…" } }

POST /v1/admin/chat/polls/:pollId/close
→ 200 { "ok": true }   // tutup paksa polling bermasalah + audit log

GET  /v1/admin/showcase/comments?status=all|visible|hidden|deleted&search=&page=&limit=
→ 200 { "data": […], "page": 1, "totalPages": 5, "total": 98 }

PATCH /v1/admin/showcase/comments/:id
Body: { "action": "hide" | "unhide" | "delete", "reason?": "…" }
→ 200 { "ok": true }   // delete = soft-delete + audit log
```

## 7. Config & ops-settings (BAD-004, BAD-024, FAL-006, SEC-506)

- `FONNTE_WEBHOOK_IPS`: tiap entry divalidasi `net.isIP()` saat startup — typo
  membuat backend fail fast dengan pesan jelas (tidak lagi diam-diam mematikan OTP).
- `WALLET_ENABLED`: hanya menerima `'true'`/`'false'`; nilai lain → fail fast saat startup.
- `POST /v1/admin/users/:userId/wallet/adjust` tanpa-wallet kini → `403 WALLET_DISABLED`.
- Translation (belum ada provider — hanya config surface):
  - ops-setting `TRANSLATION_PROVIDER` (string), `TRANSLATION_API_KEY` (secret)
  - `GET /v1/admin/ops-settings/translation/health`
    → `{ "configured": false, "provider": null }` (sampai user memilih provider)
- Ops-setting kategori FINANSIAL (fee, limit penarikan, ambang disbursement, config DANA,
  `WALLET_ENABLED`) kini berubah via dual control §2 (diusulkan → disetujui admin berbeda).
  PUT/DELETE key finansial mengembalikan `{ approvalId, status: "PENDING", expiresAt }`
  (bukan mengubah langsung); non-finansial tetap langsung + audit.
  Step-up (`opsSetting.update`) wajib untuk SEMUA PUT/DELETE ops-setting.

## 8. Perubahan perilaku kecil (fail-closed)

| Endpoint | Perubahan |
|---|---|
| `GET` pesan chat | `roomId` tidak ada → `404 ROOM_NOT_FOUND` (BFE-008) |
| `POST` pesan (SendMessageDto) | batas lampiran 50 MiB; `image/heif` diterima (BFE-002/004) |
| `GET` order status | milik user lain → `403` bukan `404` (BFE-079) |
| Langganan tidak ada | `404 SUBSCRIPTION_NOT_FOUND` (BFE-080) |
| `POST` bank account | tidak lagi mengembalikan nama hasil inquiry; semua gagal verifikasi → satu kode generik + rate-limit (SEC-204) |
| `PATCH` bank account (ganti nama) | `isVerified` di-reset ke `false` — verifikasi ulang diperlukan (SEC-207) |
| Webhook DANA | `X-TIMESTAMP` di luar ±5 menit → `403 WEBHOOK_TIMESTAMP_STALE` (SEC-206) |
| `GET` sesi aktif | tiap sesi kini memuat `deviceId` + `trusted` (BFE-046) |
| Handoff `USER` | `CaseType` kini mencakup `USER`; `page`/`limit` opsional (default 1/20) (BAD-013) |
| Feedback/voucher admin | param kanonis `dateFrom`/`dateTo`/`search` (BAD-011/012) |
| KYC assign | `DELETE /v1/admin/kyc/:kycId/assign` kini di-throttle (BAD-030) |
| Chat `createPoll` | teks polling kini lewat moderasi yang sama dengan pesan biasa (FAL-002) |
| `POST` wallet adjust | body kini WAJIB `reauthPassword` (verifikasi server-side); CREDIT > Rp1jt → `403 DUAL_CONTROL_REQUIRED` |
| `POST` commerce refund execute | body kini WAJIB `reauthPassword`; nominal > Rp1jt → `403 DUAL_CONTROL_REQUIRED` |
| `PATCH` insurance claim → PAID | tidak lagi membayar langsung — mengembalikan `{ approvalId, status: "PENDING" }`; payout oleh admin kedua |
| `POST` cancel-unshipped | body kini `ForceActionWithReauthDto` — `password` wajib (verifikasi server-side) |
| Pencarian user admin | nomor HP dinormalisasi format Indonesia dulu (FAL-024) |
| Ekspor CSV findings | menghormati filter list yang aktif (status/minDifferenceIdr/maxAgeDays/invariant/urgentOnly) (BAD-020) |
| `GET /v1/admin/finance/export/csv` | kini ekspor DAFTAR TRANSAKSI (bukan ringkasan) dengan filter `type`/`status`/`q` + `startDate`/`endDate` wajib (BAD-033) |
| `GET` analytics top-users | `startDate`/`endDate` opsional — bila diisi, peringkat dari agregat order/rating dalam rentang (BAD-034) |
| Reset-2FA/hapus/unlock/reset-password admin | body opsional `reason` tercatat di audit; reaktivasi `reason` WAJIB (BAD-028/029) |

## 9. Kontrak captcha login admin (FAL-026)

ADA. `AdminAuthService.loginAdmin` (`src/modules/admin/auth/admin-auth.service.ts:65-73`, AUT-003):

1. `captchaService.shouldRequireLoginCaptcha(ip)` — setelah N login gagal dari IP ini,
   login WAJIB menyertakan captcha.
2. Bila captcha diwajibkan tetapi `captchaId`/`captchaAnswer` tidak dikirim →
   `401 { code: "CAPTCHA_REQUIRED", message: "Captcha verification is required after repeated failed login attempts" }`
   (kredensial BELUM dicek — fail-closed sebelum verifikasi password).
3. Bila dikirim → `captchaService.verifyChallenge(captchaId, captchaAnswer)` dulu,
   baru kredensial dicek.
4. Hanya kegagalan `INVALID_CREDENTIALS` yang dihitung (`recordLoginFailure(ip)`) —
   pola yang sama dengan login mobile.

Kontrak untuk admin panel: tangkap `CAPTCHA_REQUIRED` → tampilkan slider captcha →
ulangi login dengan `captchaId` + `captchaAnswer`.
