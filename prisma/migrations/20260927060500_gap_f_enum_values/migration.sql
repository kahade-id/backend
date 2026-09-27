-- GAP-F: 4 nilai enum yang hanya tertulis sebagai komentar di migrasi
-- 202609270601_moderation_lifecycle. Idempoten (IF NOT EXISTS).
-- ALTER TYPE ... ADD VALUE aman di dalam transaksi pada PostgreSQL >= 12.

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MODERATION_REPORT_UPDATE';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MODERATION_ITEM_TAKEDOWN';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MODERATION_APPEAL_DECIDED';
ALTER TYPE "UserAuditAction" ADD VALUE IF NOT EXISTS 'SHOWCASE_APPEAL_FILED';
