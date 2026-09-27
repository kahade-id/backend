-- ============================================================================
-- FRAGMENT: nilai enum GAP-F yang hilang dari 202609270601_moderation_lifecycle
-- ============================================================================
-- Latar: 4 statement ALTER TYPE ... ADD VALUE di bagian 1 file
-- prisma/migrations/202609270601_moderation_lifecycle/migration.sql hanya
-- ditulis sebagai KOMENTAR (dokumentasi) dengan instruksi "jalankan manual
-- via psql di luar transaksi". Akibatnya `prisma migrate deploy` TIDAK
-- menambahkan 4 nilai ini ke DB, padahal schema.prisma dan kode src
-- memakainya:
--   - NotificationType.MODERATION_REPORT_UPDATE / MODERATION_ITEM_TAKEDOWN /
--     MODERATION_APPEAL_DECIDED  (dipakai admin-showcase-reports.service.ts,
--     moderation-lifecycle.constants.ts, notification-category.map.ts)
--   - UserAuditAction.SHOWCASE_APPEAL_FILED
--     (dipakai admin-showcase-reports.service.ts:1670)
-- Tanpa nilai ini, INSERT notifikasi / audit log dengan nilai tersebut gagal
-- dengan "invalid input value for enum".
--
-- CATATAN KOREKSI: klaim di header migrasi 601 bahwa "ALTER TYPE ... ADD VALUE
-- tidak bisa dijalankan di dalam blok transaksi" TIDAK BERLAKU untuk
-- PostgreSQL >= 12 (server produksi: PostgreSQL 16). Bukti: migrasi
-- 20260417_full_schema_sync (sudah ter-apply di produksi) memakai
-- ALTER TYPE ... ADD VALUE IF NOT EXISTS sebagai statement top-level di dalam
-- transaksi Prisma migrate. Jadi fragment ini AMAN dijalankan via
-- `prisma migrate deploy` — langkah manual psql TIDAK diperlukan.
--
-- CARA DEPLOY (lakukan SEBELUM `prisma migrate deploy` pertama yang mencakup
-- 13 migrasi 20260927*, atau sebagai bagian dari batch deploy yang sama):
--
--   Opsi A (DISARANKAN) — jadikan migrasi Prisma baru:
--     mkdir -p prisma/migrations/20260927060500_gap_f_enum_values
--     cp prisma/fixes/fragments/20260927060500_gap_f_enum_values.sql \
--        prisma/migrations/20260927060500_gap_f_enum_values/migration.sql
--     # nama direktori 20260927060500 terurut leksikografis SETELAH
--     # 202609270604_observability dan SEBELUM 20260927070000_gap_d_stock
--     # lalu jalankan: prisma migrate deploy
--
--   Opsi B — gabungkan ke migrasi 601 SEBELUM migrate deploy pertama
--   (uncomment 4 baris di bagian 1 migration.sql 601). Hanya boleh dilakukan
--   bila 601 BELUM PERNAH di-apply di environment target (belum ada checksum
--   tercatat di _prisma_migrations).
--
-- Idempoten (IF NOT EXISTS): aman dijalankan ulang.
-- ============================================================================

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MODERATION_REPORT_UPDATE';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MODERATION_ITEM_TAKEDOWN';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MODERATION_APPEAL_DECIDED';
ALTER TYPE "UserAuditAction" ADD VALUE IF NOT EXISTS 'SHOWCASE_APPEAL_FILED';
