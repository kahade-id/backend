# Runbook On-Call — Kahade (G495)

Panduan operasional untuk engineer yang sedang piket. Baca
`docs/incident-severity.md` untuk klasifikasi SEV dan
`docs/alert-pipeline-test.md` untuk memverifikasi jalur alert masih hidup.

## Kontak & eskalasi

| Peran | Tanggung jawab |
|---|---|
| On-call (piket) | Triase ≤ 15 menit, mitigasi, update halaman status |
| Secondary | Backup bila on-call tidak merespons 15 menit |
| CTO / pemilik produk | Keputusan freeze rilis, komunikasi eksternal SEV1 |

Jadwal piket: (diisi tim — nama + nomor di sistem internal, BUKAN di repo).

## Peta endpoint observability

| Kebutuhan | Endpoint | Akses |
|---|---|---|
| Latency p95/p99 per route | `GET /v1/admin/observability/latency` | SUPER_ADMIN |
| Ringkasan latency (agregat) | `GET /v1/admin/observability/latency/summary` | semua role admin |
| Buffer span bisnis | `GET /v1/admin/observability/spans` | SUPER_ADMIN |
| Backlog antrean Bull | `GET /v1/admin/observability/queues` | SUPER_ADMIN |
| Status dependensi | `GET /v1/admin/observability/dependencies` | semua role admin |
| Alert aktif | `GET /v1/admin/observability/alerts` | semua role admin |
| Evaluasi alert manual | `POST /v1/admin/observability/alerts/evaluate` | SUPER_ADMIN |
| Resolve alert | `POST /v1/admin/observability/alerts/:key/resolve` | SUPER_ADMIN |
| Delivery push/email/OTP | `GET /v1/admin/observability/delivery` | SUPER_ADMIN |
| Metrik WebSocket | `GET /v1/admin/observability/websocket` | SUPER_ADMIN |
| Synthetic check | `POST /v1/admin/observability/synthetic/run` | SUPER_ADMIN |
| Kelola insiden status | `GET/POST /v1/admin/observability/incidents`, `PATCH …/incidents/:id` | baca: semua role; tulis: SUPER_ADMIN |
| Halaman status publik | `GET /v1/status` (tanpa auth) | publik |
| Synthetic eksternal | `GET /v1/health/synthetic` (tanpa auth) | publik/monitoring |
| Health lengkap | `GET /v1/health` | publik (ringan, throttle) |

Halaman admin (belum di nav — akses via URL langsung, SUPER_ADMIN):
`/observability` (latency, antrean, dependensi, delivery, WS, span, alert),
`/status` (kelola insiden + pratinjau publik).

## Akses (G499)

- **Metrik detail** (per-route, queue depth, delivery, WS, span, storage):
  SUPER_ADMIN saja. Guard: `@AdminRoles('SUPER_ADMIN')`.
- **Agregat** (ringkasan latency, status dependensi, daftar alert, daftar
  insiden): semua role admin (`SUPER_ADMIN`, `DISPUTE_ADMIN`, `KYC_ADMIN`,
  `FINANCE_ADMIN`, `CUSTOMER_SUPPORT`).
- **Aksi** (resolve alert, kelola insiden, synthetic test): SUPER_ADMIN.
- Tidak ada enum `AdminRole` baru; tidak ada perubahan `@AdminRoles` existing.
- Payload observability TIDAK PERNAH berisi PII: span hanya atribut skalar
  aman, delivery hanya counter, alert context hanya angka diagnostik.

## Playbook per alert

Setiap alert punya `key`, threshold, dan cooldown 30 menit (anti-storm).
Alert dicatat di `alert_events` (lifecycle RAISED → ACKNOWLEDGED → RESOLVED),
di `AdminAuditLog` `[SYSTEM ALERT]`, di log error, dan (opsional) ke
`OPS_ALERT_WEBHOOK_URL`.

### `login_errors` (critical) — >50 kegagalan login / 5 menit
1. Cek `/v1/admin/observability/latency?route=/v1/auth/login` — apakah 5xx
   naik (bug) atau 4xx naik (serangan brute force / kredensial bocor).
2. Bila 4xx dominan: cek rate-limit & pola IP di log (`X-Request-Id` membantu
   korelasi); pertimbangkan blokir sementara via WAF.
3. Bila 5xx dominan: cek `dependencies` (DB/Redis) + span `order.*` tidak
   relevan — fokus ke auth; rollback rilis terakhir bila korelasi waktu cocok.

### `otp_errors` (critical) — >50 kegagalan OTP / 5 menit
1. Cek `dependencies` → `otp_provider`: provider & `tokenConfigured`.
   Bila `down`: verifikasi token Fonnte/Twilio (ingat insiden token
   "unknown user" 2026-09-26).
2. Cek `/v1/admin/observability/delivery` → rasio `otp/failed`.
3. Mitigasi: bila provider down > 15 menit → umumkan di halaman status
   (komponen "OTP WhatsApp" → degraded), buat insiden SEV2.

### `payment_pending` (warning/critical) — rasio PENDING > 20%/jam (min. 20 tx)
1. Cek `webhook_retry`: apakah webhook Midtrans menumpuk belum terproses.
2. Cek span `payment.webhook` — latency & status error.
3. Jangan mutasi manual status transaksi; tunggu retry otomatis / jalankan
   rekonsiliasi. Eskalasi ke SEV1 bila > 50% selama 30 menit.

### `webhook_retry` (warning/critical) — >100 webhook MIDTRANS siap retry
1. Cek log worker webhook + DLQ.
2. Bila signature gagal massal: verifikasi server key Midtrans (jangan
   rotasi tanpa koordinasi).

### `dlq_depth` (warning/critical) — >50 job di dead-letter
1. Buka halaman Sistem → Webhook dead-letter di admin; identifikasi pola.
2. Retry yang aman-idempoten saja; sisanya investigasi root cause.

### `disk_usage` (warning ≥80%, critical ≥90%) / `table_growth` (>5 GB tabel log)
1. `disk_usage`: hapus file temp `synthetic-*` yatim, audit direktori upload;
   bila > 90%: SEV2, siapkan ekspansi volume.
   Indikator ini memeriksa **volume storage** (`STORAGE_PATH`, default
   `/var/www/kahade-storage`) DAN `/` — ambil yang paling penuh; detail respons
   memuat `path`, `usedPercent`, `freeMb`, `storageUsedPercent`,
   `rootUsedPercent`.
2. `table_growth`: jadwalkan archival/purge `webhook_log`, `audit_log`,
   `admin_audit_log`, `notification_log` (lihat `docs/backup-restore-drill.md`).

### Upload video/file bermasalah ("Memproses video..." menggantung, foto/PDF rusak)
Cari prefix log berikut (satu request = satu `requestId`):

| Log | Arti / tindakan |
|---|---|
| `[ffmpeg-check] ... TIDAK tersedia` | ffmpeg/ffprobe tidak ada di PATH server → instal (atau set `FFPROBE_PATH`/`FFMPEG_PATH`). Upload video ditolak fail-closed (500). |
| `[ffmpeg-slot] ... menunggu slot` / `menunggu Nms` | >2 proses ffmpeg bersamaan (semaphore). Bila antrean menumpuk lama: cek proses ffprobe/ffmpeg yang nyangkut (`ps`), lihat baris berikutnya. |
| `[VIDEO_PROBE]/[VIDEO_THUMBNAIL] ... watchdog anti-hang` | proses biner tidak berhenti setelah timeout → SIGKILL paksa. Cek storage/file yang diproses (I/O tak terputus, file korup). |
| `[video-probe] gagal` / `[video-thumbnail] gagal` + `elapsed` | tahap gagal + durasinya; `VIDEO_UNPROCESSABLE` = bukan video valid. |
| `[showcase-video] mulai/probe-ok/thumbnail-mulai/selesai/gagal` | progres pipeline video (size, duration, dim, elapsed). `gagal` memuat alasan + file dihapus. |
| `[chunked] complete mulai/rakit selesai/selesai/gagal` | jalur upload besar: pisahkan durasi rakit vs pemrosesan ffmpeg. |
| `[storage] ... errno=ENOSPC capacity=true` atau respons `503 UPLOAD_STORAGE_UNAVAILABLE` | **disk/kuota penuh atau FS read-only** → SEV2: bebaskan ruang pada volume `STORAGE_PATH`, cek `df -h`; retry aman setelah ruang tersedia. |
| `[chunked] tulis chunk gagal ... errno=` | kegagalan menulis staging (`<STORAGE_PATH>/.chunks`); `.part` sudah dibersihkan otomatis. |
| `GET /v1/upload/s` mengembalikan `application/json` | regresi Bug #1 (payload biner ter-bungkus envelope). Bukan masalah data — periksa `ResponseTransformInterceptor`. |

Catatan infra: Nginx harus memakai `client_max_body_size 115m` +
`proxy_request_buffering off` untuk `/v1/upload/` (dan `55m` untuk unggah
lampiran chat) dengan `proxy_read_timeout ≥300s`, kalau tidak upload besar
ditolak 413/504 sebelum sampai aplikasi (lihat `nginx/nginx.conf`).

## Triase cepat (15 menit)

1. Buka `/v1/status` — status keseluruhan & komponen.
2. Buka halaman admin `/observability` — alert aktif + latency + dependensi.
3. Ambil `X-Request-Id` dari laporan user → cari di log (`requestId` ada di
   konteks logger + span + Sentry `requestId`).
4. Tentukan SEV (lihat `docs/incident-severity.md`), buat/update insiden di
   halaman `/status` bila berdampak publik.
5. Mitigasi dulu (rollback / scale / failover), root cause belakangan.

## Setelah insiden

- Resolve alert di halaman observability setelah verifikasi pulih.
- Update insiden → RESOLVED dengan ringkasan publik (tanpa PII).
- SEV1/SEV2: postmortem ≤ 3 hari kerja, action item bertanggal & pemilik.
