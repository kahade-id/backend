# Panduan Pengaktifan `pg_stat_statements` di Production

> **Status: NEEDS-APPROVAL — JANGAN dijalankan tanpa persetujuan eksplisit.**
> Temuan audit: BD-009 (P2). File SQL: `prisma/manual/20261010_pg_stat_statements.sql`
> (direktori `prisma/manual/` TIDAK di-apply otomatis oleh Prisma — eksekusi manual).

## Kenapa

`SELECT count(*) FROM pg_extension WHERE extname = 'pg_stat_statements'` → **0** di
production (temuan audit 2026-09-28). Akibatnya tim tidak punya data
"top query by total_time" — setiap klaim performa sisi DB tidak bisa diverifikasi
dari data produksi dan audit terpaksa mengandalkan analisis statis.

## Prasyarat penting

`pg_stat_statements` **wajib** dimuat lewat `shared_preload_libraries`, dan parameter
itu hanya bisa diubah dengan **restart PostgreSQL** (konteks `postmaster`).
`CREATE EXTENSION` tanpa preload akan sukses tapi view `pg_stat_statements`
tetap kosong — jadi urutan langkah di bawah tidak bisa dibalik.

Server produksi: PostgreSQL 16 via apt, config di
`/etc/postgresql/16/main/postgresql.conf`, service `postgresql@16-main`.

## Langkah eksekusi (maintenance window)

1. **Backup config** (di server, user dengan sudo):
   ```bash
   sudo cp /etc/postgresql/16/main/postgresql.conf \
     /root/postgresql.conf.bak-$(date +%Y%m%d)
   ```
2. **Tambah ke `shared_preload_libraries`** — edit
   `/etc/postgresql/16/main/postgresql.conf`:
   ```ini
   shared_preload_libraries = 'pg_stat_statements'
   # Batas entri yang dilacak (default 5000; 10000 aman untuk beban Kahade)
   pg_stat_statements.max = 10000
   pg_stat_statements.track = top
   pg_stat_statements.track_utility = off
   ```
   Bila `shared_preload_libraries` sudah berisi nilai lain, tambahkan dengan koma
   (jangan timpa), mis. `'existing_lib,pg_stat_statements'`.
3. **Restart PostgreSQL** (downtime ± beberapa detik — lakukan di jam sepi):
   ```bash
   sudo systemctl restart postgresql@16-main
   sudo systemctl is-active postgresql@16-main
   ```
4. **Verifikasi preload aktif:**
   ```sql
   SHOW shared_preload_libraries;  -- harus memuat pg_stat_statements
   ```
5. **Buat extension di database aplikasi** (sebagai user DB Kahade):
   ```bash
   psql "$DATABASE_URL" -f prisma/manual/20261010_pg_stat_statements.sql
   ```
   atau jalankan isi file tersebut manual via psql.
6. **Verifikasi pengumpulan data:**
   ```sql
   SELECT count(*) FROM pg_extension WHERE extname = 'pg_stat_statements';  -- harus 1
   -- Tunggu beberapa menit trafik, lalu:
   SELECT query, calls, total_exec_time, mean_exec_time
   FROM pg_stat_statements
   ORDER BY total_exec_time DESC
   LIMIT 10;
   ```
   Baris muncul = pelacakan berjalan.

## Risiko

| Risiko | Mitigasi |
|---|---|
| Downtime restart (± detik–1 menit) | Maintenance window jam sepi; health check `GET /v1/health` setelah restart |
| Overhead CPU 1–5% + memori (~1 KB/entri × `pg_stat_statements.max`) | Nilai konservatif di atas; pantau 24 jam pertama |
| Restart gagal karena typo config | Backup config langkah 1; `sudo -u postgres pg_ctlcluster 16 main check` sebelum restart bila ragu |
| Query dengan literal ikut tercatat (bukan PII kolom, tapi pola query) | Akses view dibatasi role DB aplikasi; tidak diekspos ke endpoint mana pun |

## Rollback

```bash
# Kembalikan config dari backup, lalu restart lagi
sudo cp /root/postgresql.conf.bak-<tanggal> /etc/postgresql/16/main/postgresql.conf
sudo systemctl restart postgresql@16-main
```
Opsional: `DROP EXTENSION IF EXISTS pg_stat_statements;` di database aplikasi
(data statistik ikut terhapus).

## Alternatif sementara TANPA restart (boleh jalan kapan saja)

Bila restart belum disetujui, aktifkan slow-query log (konteks `sighup`,
cukup reload — tanpa downtime):

```sql
ALTER SYSTEM SET log_min_duration_statement = 500;  -- catat query > 500 ms
SELECT pg_reload_conf();
```

Lalu baca log: `sudo tail -f /var/log/postgresql/postgresql-16-main.log`.
Ini memberi visibilitas parsial (hanya query lambat) sambil menunggu
persetujuan restart untuk `pg_stat_statements` penuh.

## Checklist persetujuan

- [ ] Maintenance window disepakati (tanggal/jam)
- [ ] Backup config dibuat (langkah 1)
- [ ] Eksekusi langkah 2–6 oleh yang berwenang
- [ ] Verifikasi langkah 6 menunjukkan baris data
- [ ] Pantau 24 jam: CPU, memori, error rate API
