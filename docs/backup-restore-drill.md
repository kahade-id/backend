# Drill Backup & Restore (G498)

Jadwal: drill restore PENUH tiap kuartal; drill parsial (satu tabel) tiap
bulan. Hasil drill dicatat di bawah (tanggal, pelaku, hasil, temuan).

## Cakupan backup

| Data | Metode | Frekuensi | Retensi |
|---|---|---|---|
| PostgreSQL (semua tabel incl. `alert_events`, `incident_logs`) | `pg_dump` / snapshot volume | Harian | 30 hari |
| Direktori upload `/var/www/kahade-storage` | snapshot/rsync | Harian | 30 hari |
| Redis (cache & Bull) | RDB/AOF | Harian | 7 hari (cache — boleh hilang; antrean kritis harus drain dulu) |
| `.env` produksi (`/var/www/kahade/.env`) | vault offline terenkripsi | Tiap perubahan | Versi |
| Konfigurasi nginx | snapshot `/etc/nginx` | Tiap perubahan | Versi |

Catatan: file lama di Cloudflare R2 adalah data legacy (tidak dimigrasi
sejak 2026-09-26) — BUKAN bagian dari backup rutin; aksesnya read-only.

## Checklist drill restore

### Persiapan
- [ ] Tentukan target: database staging/isolated (JANGAN pernah restore ke
      produksi sebagai "drill").
- [ ] Pastikan backup terakhir < 24 jam dan checksum cocok.
- [ ] Bekukan deploy selama drill (tandai di grup on-call).

### Restore database
- [ ] Restore ke instance kosong: `pg_restore` / `psql < dump`.
- [ ] Jalankan `prisma migrate deploy` — harus "no pending migrations".
- [ ] Verifikasi jumlah baris tabel kritis vs produksi (± toleransi wajar):
      `users`, `orders`, `wallet_transactions`, `payment_transactions`.
- [ ] Verifikasi PII terdekripsi dengan benar (satu sampel user uji —
      JANGAN data user asli di luar kebutuhan).

### Restore storage
- [ ] Restore `/var/www/kahade-storage` ke path staging.
- [ ] Verifikasi: file publik (avatars/showcase) dapat dibaca; file privat
      TIDAK dapat diakses anonim (aturan nginx 404 untuk prefix privat).

### Verifikasi aplikasi
- [ ] Boot backend staging menunjuk DB hasil restore → `/v1/health` 200.
- [ ] `/v1/health/synthetic` → `ok` (DB select 1, Redis ping, storage temp).
- [ ] Login uji dengan akun staging → JWT terbit.
- [ ] Saldo wallet akun uji cocok dengan sebelum restore.

### Selesai
- [ ] Catat durasi tiap tahap (target RTO/RPO di bawah).
- [ ] Hapus data restore bila tidak diperlukan lagi (hindari PII ganda).
- [ ] Tulis temuan + action item; laporkan di grup on-call.

## Target

- **RPO** (data hilang maksimal): 24 jam (backup harian).
- **RTO** (pulih total): ≤ 4 jam untuk skenario DB; ≤ 8 jam untuk
  skenario penuh (DB + storage).

## Riwayat drill

| Tanggal | Cakupan | Pelaku | Hasil | Temuan |
|---|---|---|---|---|
| (belum ada) | | | | |

## Larangan

- Jangan menyimpan backup di direktori web yang dapat diakses publik.
- Jangan mengirim dump berisi PII lewat kanal tanpa enkripsi.
- Jangan menguji restore di database produksi.
