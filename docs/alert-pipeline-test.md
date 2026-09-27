# Uji Pipeline Alert End-to-End (G500)

Tujuan: membuktikan jalur `deteksi → alert log → notifikasi admin → resolve`
masih hidup, BUKAN sekadar "kode ada". Dijalankan tiap deploy observability
dan tiap bulan via cron manual.

## Cara 1 — tombol di halaman admin (disarankan)

1. Buka halaman admin `/observability` (SUPER_ADMIN).
2. Klik **"Uji pipeline alert"**.
3. Hasil yang diharapkan: toast **"Uji pipeline alert OK"**
   (`raised=true`, `resolved=true`, `key=synthetic_test`).
4. Verifikasi manual:
   - `GET /v1/admin/observability/alerts` — tidak ada `synthetic_test` aktif
     (sudah di-resolve oleh skrip uji).
   - Log backend mengandung `[ALERT:WARNING] synthetic_test`.
   - `AdminAuditLog` punya baris `[SYSTEM ALERT][WARNING] Alert sintetis…`
     (permukaan yang dibaca halaman admin).

## Cara 2 — API langsung

```bash
# 1. Picu alert sintetis (butuh JWT admin SUPER_ADMIN)
curl -s -X POST https://api.kahade.id/v1/admin/observability/alerts/synthetic-test \
  -H "Authorization: Bearer $ADMIN_JWT"
# → {"raised":true,"resolved":true,"key":"synthetic_test"}

# 2. Pastikan tidak ada sisa aktif
curl -s https://api.kahade.id/v1/admin/observability/alerts \
  -H "Authorization: Bearer $ADMIN_JWT" | grep -c synthetic_test
# → 0
```

## Cara 3 — uji aturan nyata (threshold)

Untuk memastikan *aturan* (bukan cuma plumbing) bekerja, picu dengan sinyal
asli di staging:

| Aturan | Cara picu di staging | Ekspektasi |
|---|---|---|
| `login_errors` | 51x `POST /v1/auth/login` kredensial salah dalam 5 mnt | alert critical `login_errors` |
| `otp_errors` | 51x request OTP gagal dalam 5 mnt | alert critical `otp_errors` |
| `payment_pending` | buat 20+ transaksi, tahan 5 dalam PENDING > 1 jam | alert `payment_pending` |
| `disk_usage` | (jangan diisi manual) — verifikasi via `GET …/observability/storage` | evaluasi on-demand jalan |

Setelah tiap uji: resolve alert via
`POST /v1/admin/observability/alerts/:key/resolve`.

## Anti-storm

- Tiap kunci alert punya cooldown 30 menit: alert yang sama tidak dikirim
  ulang dalam cooldown (tapi `lastSeenAt` diperbarui).
- Uji sintetis memakai kunci khusus `synthetic_test` — tidak mengganggu
  cooldown alert produksi.
- Jangan menjalankan uji threshold di produksi di jam sibuk.

## Bila uji GAGAL

1. Cek log: `Alert evaluation failed` / `Alert rule failed` — aturan mana
   yang melempar.
2. Cek tabel `alert_events` ada (migrasi `202609270604_observability`
   sudah jalan): `SELECT count(*) FROM alert_events;`
3. Cek interval scheduler jalan (`@Interval(60_000)` di `AlertsService` —
   butuh `ScheduleModule` aktif).
4. Bila notifikasi admin tidak muncul: cek ada `admin_users` aktif; bila
   kosong, service fallback ke 1 admin aktif mana pun.
5. Bila webhook eksternal tidak terpanggil: cek `OPS_ALERT_WEBHOOK_URL`
   (harus `https://…`).
