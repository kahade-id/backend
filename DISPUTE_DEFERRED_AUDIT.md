# Audit Deferred — Sengketa/Dispute (2026-09-26)

Empat deferred issue dari audit sengketa. Status: 3 diimplementasikan aman,
1 jadi rekomendasi produk (guard tersedia, perilaku dana tidak berubah).

## 1. Platform fee saat putusan FULL_BUYER — REKOMENDASI (keputusan produk terbuka)

### Perilaku saat ini (audit kode `AdminDisputesService.resolveDispute`)
| Putusan | Pembeli terima | Penjual terima | Platform tahan |
|---|---|---|---|
| FULL_BUYER | `sellerReceiveAmount` (nilai order) | 0 | `platformFee` penuh (`buyerPayAmount − sellerReceiveAmount`) |
| FULL_SELLER | 0 | `sellerReceiveAmount` | `platformFee` penuh |
| SPLIT x/y | proporsi `sellerReceiveAmount` | sisanya | `platformFee` penuh |

Artinya: saat transaksi **batal total** dan dana dikembalikan ke pembeli,
**platform fee TIDAK ikut refund** — pembeli menerima kurang dari total yang
dibayar (`buyerPayAmount`). Untuk sengketa pasca-completion, fee = 0 sehingga
tidak ada selisih.

### Yang diimplementasikan
Guard `DISPUTE_FULL_BUYER_REFUNDS_PLATFORM_FEE` di
`src/common/constants/app.constants.ts` (**default `false`** → perilaku dana
tidak berubah). Cabang `true` sudah dikodekan di `resolveDispute`:
pembeli menerima `buyerPayAmount` penuh (`escrowedAmount`), platform tidak
menahan fee. Hasil putusan dicatat di audit log (`after.platformFeeRefundedToBuyer`).

### Rekomendasi
Set `true` — fee ikut refund saat transaksi batal total. Alasan:
1. Adil: pembeli tidak menerima apa pun dari transaksi yang gagal.
2. Full refund biasanya akibat kesalahan penjual/sistem, bukan pembeli.
3. Mengurangi keluhan "uang kembali tidak penuh".
**JANGAN aktifkan tanpa persetujuan eksplisit product** — ini mengubah aliran
dana escrow.

## 2. SLA tahap kedua pasca-ESCALATED — IMPLEMENTASI

Setelah status ESCALATED, admin punya **3×24 jam** (`DISPUTE_ESCALATION_SLA_HOURS`)
untuk memberi putusan:
- Kolom: `escalatedAt`, `escalationSlaDeadlineAt`, `escalationSlaWarningSentAt`,
  `isEscalationSlaBreached` (migration `20260926190000_dispute_sla2_category`).
- Deadline di-set saat eskalasi manual (`DisputesService.escalateDispute`) maupun
  otomatis (`AutoEscalateDisputesService`).
- Scheduler baru `DisputeEscalationSlaService` (cron tiap 30 menit):
  - **Warning** 24 jam sebelum deadline → notifikasi in-app + push ke kedua pihak
    (`DISPUTE_ESCALATION_SLA_WARNING`).
  - **Breach** melewati deadline → tandai `isEscalationSlaBreached`, notifikasi
    urgent ke kedua pihak (`DISPUTE_ESCALATION_SLA_BREACHED`), audit log untuk
    admin/mediator senior.

## 3. Notifikasi user offline — IMPLEMENTASI + BUG FIX

- Pesan dispute: jika lawan offline (`RealtimeService.isUserOnline`), buat
  notifikasi in-app `DISPUTE_MESSAGE_RECEIVED`.
- **Bug yang ditemukan & diperbaiki (2026-09-26):** push hanya dikirim lewat
  hook `emitNotificationCreated` (PushService) — sebelumnya kode hanya membuat
  row notifikasi tanpa emit, sehingga **push tidak pernah terkirim** untuk pesan
  dispute offline. Sekarang emit dipanggil setelah row dibuat. Bug yang sama
  diperbaiki di notifikasi SLA warning/breach scheduler.
- Putusan dispute (`DISPUTE_DECISION`), bukti, klaim, dan mutual resolution
  sudah memanggil emit → push terkirim.

## 4. Kategori sengketa — IMPLEMENTASI

- Enum backend `DisputeCategory`: `ITEM_NOT_RECEIVED`, `ITEM_NOT_AS_DESCRIBED`,
  `DAMAGED_ITEM`, `WRONG_ITEM`, `SERVICE_NOT_RENDERED`, `PAYMENT_ISSUE`,
  `FRAUD`, `OTHER` (nullable agar data lama aman; wajib diisi saat buka sengketa baru).
- Mobile: dropdown kategori di sheet buka sengketa (`order/[id].tsx` →
  `order-action-sheets.tsx`), label terpusat di `lib/labels/dispute.ts`,
  kategori tampil di layar detail sengketa.
- Admin web: filter kategori di daftar sengketa, badge kategori di tabel,
  kategori tampil di halaman detail (backend `GET /v1/admin/disputes`
  mendukung `?category=`).

## File yang diubah (batch ini)
- backend: `src/common/constants/app.constants.ts`,
  `src/modules/admin/disputes/admin-disputes.service.ts`,
  `src/modules/disputes/dispute-message.service.ts`,
  `src/modules/scheduler/services/dispute-escalation-sla.service.ts`
- admin: `src/lib/api/admin/disputes.ts`,
  `src/app/(panel)/disputes/page.tsx`, `src/app/(panel)/disputes/[id]/page.tsx`,
  `src/app/(panel)/disputes/maps.ts`
- frontend: `lib/api/disputes.ts`, `components/dispute-detail-sections.tsx`
- (sebelumnya, batch audit): migration `20260926190000_dispute_sla2_category`,
  `disputes.service.ts`, `auto-escalate-disputes.service.ts`,
  scheduler module/index, notification-category map, admin DTO/controller.
