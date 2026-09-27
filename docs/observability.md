# Observabilitas — Sampling, Span & Akses (G491/G499)

## Kebijakan sampling (G491)

Tanpa vendor, tanpa biaya ingest per-span. Implementasi:
`backend/src/common/tracing/tracing.ts` (`withSpan`).

| Kategori | Kebijakan |
|---|---|
| Transaksi **gagal** (span status `error`) | **100%** direkam |
| Transaksi sukses bervolume tinggi | **1%** acak |
| Metrik latency per route | semua request route kunci masuk ring buffer (1000 sampel/route) — bukan sampling, melainkan agregasi |

Buffer: 500 span terakhir (in-memory per worker). Statistik sampling
(`buffered`, `sampledOut`, `successSampleRate`) diekspos di
`GET /v1/admin/observability/spans`.

Rasional: kegagalan adalah sinyal paling berharga saat insiden — tidak ada
kegagalan yang boleh hilang karena sampling. Sukses bervolume tinggi
(login, feed) hanya butuh sampel untuk distribusi latency.

## Aturan atribut span (produk keuangan — WAJIB)

`withSpan` menolak atribut bertipe objek (melempar) agar payload mentah
tidak pernah masuk tidak sengaja. Aturan per domain:

- **payment/webhook**: HANYA `{ provider, amount, currency, status, latencyMs }`.
  Tanpa `order_id` mentah, tanpa payload webhook, tanpa IP, tanpa nomor
  rekening/token.
- **upload**: HANYA `{ fileKeyHash (SHA-256), size, mime, purpose }`.
  Tanpa isi file, tanpa nama file asli, tanpa userId mentah.
- **order**: HANYA `{ orderType, currency }`. Tanpa title/description/username.
- **error**: hanya `errorName` (nama kelas) — TANPA message/stack mentah
  yang bisa mengandung PII.

Pelanggaran aturan ini = bug keamanan (P1).

## Korelasi request (G478)

- Backend: `RequestIdInterceptor` (global) — memakai `X-Request-Id` klien
  bila UUID v4 valid, generate bila tidak; mengembalikan di response header
  `X-Request-ID`; menyimpan di `AsyncLocalStorage` (`requestContext`) untuk
  konteks logger + span.
- Frontend (`lib/api/client.ts`): setiap request mengirim `X-Request-Id`.
- Admin web (`src/lib/api/admin-client.ts`): sama.
- Logger winston menyertakan `requestId`; Sentry error event juga
  (`all-exceptions.filter.ts`) + `release`.

## Matriks akses observability (G499)

| Permukaan | SUPER_ADMIN | Role admin lain | Publik |
|---|---|---|---|
| `GET …/observability/latency` (per-route) | ✅ | ❌ | ❌ |
| `GET …/observability/latency/summary` (agregat) | ✅ | ✅ | ❌ |
| `GET …/observability/spans` | ✅ | ❌ | ❌ |
| `GET …/observability/queues` | ✅ | ❌ | ❌ |
| `GET …/observability/dependencies` | ✅ | ✅ | ❌ |
| `GET …/observability/alerts` | ✅ | ✅ | ❌ |
| `POST …/alerts/evaluate`, `…/alerts/:key/resolve`, `…/alerts/synthetic-test` | ✅ | ❌ | ❌ |
| `GET …/observability/delivery`, `…/websocket`, `…/storage` | ✅ | ❌ | ❌ |
| `POST …/synthetic/run` | ✅ | ❌ | ❌ |
| `GET/POST/PATCH …/observability/incidents` | ✅ tulis | ✅ baca | ❌ |
| `GET /v1/status` | ✅ | ✅ | ✅ (tanpa auth, throttle) |
| `GET /v1/health`, `GET /v1/health/synthetic` | ✅ | ✅ | ✅ (tanpa auth, throttle) |

Tidak ada perubahan `@AdminRoles` existing; tidak ada enum `AdminRole` baru.
Halaman admin: `/observability` dan `/status` (belum di nav — akses URL
langsung, SUPER_ADMIN; lihat `docs/runbook-oncall.md` § "Peta endpoint").
