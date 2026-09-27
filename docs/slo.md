# SLO & Error Budget — Alur Kritis Kahade (G487)

Dokumen kanonis target keandalan alur kritis. Dievaluasi tiap insiden SEV1/SEV2
dan ditinjau ulang tiap kuartal. Angka di bawah adalah *target*; realisasi
dibaca dari endpoint observability (`/v1/admin/observability/latency`,
`/v1/admin/observability/delivery`, `/v1/status`).

## Definisi

- **SLO**: target persentase keberhasilan dalam jendela 30 hari bergulir.
- **Error budget**: 100% − SLO. Bila budget habis sebelum akhir jendela →
  freeze rilis non-darurat sampai budget pulih (keputusan on-call + CTO).
- **Pengukuran**: backend — ring buffer `MetricsService` (p95/p99 per route),
  `DeliveryMetricsService` (delivery), `AlertsService` (aturan G485/G486).

## Tabel SLO

| Alur | SLI | SLO (30 hari) | Error budget |
|---|---|---|---|
| Login (username/HP) | keberhasilan request `POST /v1/auth/login` (5xx = gagal; 4xx kredensial salah TIDAK dihitung gagal) | 99,9% | 0,1% (~43 mnt/bulan downtime) |
| OTP WhatsApp | `record('otp', provider, 'sent')` / total percobaan kirim OTP | 99,5% | 0,5% |
| Pembuatan order | `POST /v1/orders` 2xx/4xx-validasi vs 5xx | 99,9% | 0,1% |
| Pembayaran (charge + webhook) | webhook Midtrans terproses tanpa retry > 3x; rasio PENDING ≤ 20%/jam (alert `payment_pending`) | 99,5% | 0,5% |
| Pelepasan escrow | `order.complete` tanpa error setelah konfirmasi buyer | 99,95% | 0,05% |
| Chat realtime | pesan terkirim via WS/push dalam 5 dtk | 99,0% | 1,0% |
| Push notifikasi | delivery `sent` Expo/FCM (lihat `/v1/admin/observability/delivery`) | 98,0% | 2,0% |
| Halaman status publik | `GET /v1/status` 200 < 1 dtk | 99,9% | 0,1% |

## Target latency (p95, dari `MetricsService`)

| Route kunci | p95 target |
|---|---|
| `POST /v1/auth/login` | ≤ 800 ms |
| `POST /v1/auth/*otp*` | ≤ 1.500 ms (termasuk antrean provider) |
| `POST /v1/orders` | ≤ 1.200 ms |
| `GET /v1/wallet/*` | ≤ 600 ms |
| `POST /v1/disputes` | ≤ 1.000 ms |
| `GET /v1/chat/rooms` | ≤ 600 ms |
| `GET /v1/health/synthetic` | ≤ 5.000 ms (timeout per cek) |

## Kebijakan saat error budget menipis

1. **< 50% budget tersisa**: peringatan di grup on-call; rilis fitur baru
   butuh persetujuan eksplisit.
2. **Budget habis**: freeze rilis non-darurat; hanya hotfix SEV1/SEV2.
3. **Dua jendela berturut-turut gagal**: postmortem wajib + action item
   bertanggal (lihat `docs/incident-severity.md`).

## Yang TIDAK dihitung sebagai pelanggaran SLO

- Downtime terjadwal yang diumumkan ≥ 48 jam sebelumnya di halaman status.
- Kegagalan di sisi provider pihak ketiga (Midtrans/Fonnte) yang statusnya
  `degraded` di `/v1/status` — dicatat terpisah sebagai *dependency outage*.
- 4xx akibat input user (kredensial salah, validasi) — bukan kegagalan sistem.
