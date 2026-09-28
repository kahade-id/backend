# Direktori `prisma/manual/` — SQL eksekusi MANUAL

File di direktori ini **TIDAK** dibaca/diterapkan otomatis oleh Prisma Migrate
(hanya `prisma/migrations/` yang auto-apply). Setiap file di sini dieksekusi
manual oleh yang berwenang, mengikuti runbook di `docs/`, dan **wajib**
persetujuan eksplisit bila menyentuh production.

| File | Status | Runbook |
|---|---|---|
| `20261010_pg_stat_statements.sql` | NEEDS-APPROVAL (belum dieksekusi) | `docs/pg-stat-statements-activation.md` |
