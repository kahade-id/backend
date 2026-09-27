# Partner Webhook — Changelog Payload (G472)

> Kebijakan versioning payload webhook keluar Kahade → mitra.
> Field `version` selalu ada di setiap body webhook.

## Kebijakan versi

- Versi memakai format `MAJOR.MINOR` (saat ini: **`1.0`**).
- **MINOR** (mis. `1.0` → `1.1`): penambahan field opsional yang kompatibel mundur
  (*backward-compatible*). Penerima lama tetap berfungsi; penerima disarankan
  mengabaikan field yang tidak dikenal (*forward-tolerant reader*).
- **MAJOR** (mis. `1.0` → `2.0`): perubahan *breaking* (penghapusan/rename field,
  perubahan tipe). Versi major baru **tidak** dikirim ke endpoint lama tanpa
  persetujuan eksplisit; mitra diberi masa migrasi minimum **90 hari** dan
  pemberitahuan tertulis.
- Event baru dapat ditambahkan ke registry `PARTNER_WEBHOOK_EVENTS` kapan saja —
  endpoint hanya menerima event yang ia subscribe, jadi penambahan event tidak
  breaking.

## Riwayat

### 1.0 — 2026-09-26 (rilis awal)
- Envelope: `{ version, eventId, eventType, occurredAt, data }`.
- Header: `X-Kahade-Signature`, `X-Kahade-Timestamp`, `X-Kahade-Event-Id`.
- Signature: `HMAC-SHA256(secret, timestamp + "." + eventId + "." + rawBody)` (hex).
- Event: `order.completed`, `payment.received`, `payout.completed`,
  `subscription.activated`, `webhook.test`, `webhook.challenge`.
- Anti-replay: `eventId` unik per event + jendela timestamp 5 menit
  (lihat `docs/partner-security-contract.md` § Anti-replay).
- Retry: backoff 1 mnt → 5 mnt → 15 mnt → 1 jam → 6 jam, lalu DLQ (6 percobaan).

## Prosedur perubahan payload

1. Usulkan perubahan di dokumen ini (tambah entri versi baru di atas).
2. Untuk MINOR: implementasi + uji kirim `webhook.test` ke endpoint sandbox mitra.
3. Untuk MAJOR: umumkan ke semua mitra ≥ 90 hari sebelumnya, sediakan periode
   dual-send bila diminta (payload lama + baru), lalu migrasikan per endpoint.
4. Catat keputusan di `PartnerAuditLog` (`PAYLOAD_VERSION_ANNOUNCED`).
