-- ============================================================================
-- BD-009 (perf-fix 2026-09-29): aktifkan pg_stat_statements
-- ============================================================================
-- STATUS: NEEDS-APPROVAL — JANGAN dijalankan di production tanpa persetujuan.
-- File ini TIDAK di-apply otomatis oleh Prisma (bukan di prisma/migrations/).
-- Eksekusi manual oleh yang berwenang, mengikuti runbook:
--   docs/pg-stat-statements-activation.md
--
-- PRASYARAT (tidak bisa di-skip):
--   1. `shared_preload_libraries = 'pg_stat_statements'` di postgresql.conf
--   2. RESTART PostgreSQL (parameter konteks postmaster)
-- Tanpa preload, CREATE EXTENSION sukses tapi view pg_stat_statements KOSONG.
--
-- Jalankan sebagai user database aplikasi pada database Kahade:
--   psql "$DATABASE_URL" -f prisma/manual/20261010_pg_stat_statements.sql
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Catatan: pengaturan pg_stat_statements.track / track_utility / max
-- ditaruh di postgresql.conf (lihat runbook langkah 2) karena restart
-- PostgreSQL memang wajib untuk shared_preload_libraries.

-- Verifikasi (harus mengembalikan 1 baris):
-- SELECT count(*) FROM pg_extension WHERE extname = 'pg_stat_statements';
--
-- Setelah beberapa menit trafik, cek data terkumpul:
-- SELECT query, calls, total_exec_time, mean_exec_time
-- FROM pg_stat_statements
-- ORDER BY total_exec_time DESC
-- LIMIT 10;
