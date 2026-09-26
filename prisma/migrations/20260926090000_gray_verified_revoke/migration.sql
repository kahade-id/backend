-- Tier abu (FULLY_VERIFIED): dukungan revoke manual oleh admin.
-- Badge abu bersifat OTOMATIS (KYC APPROVED + email verified + phone verified +
-- alamat lengkap + Kahade Plus aktif), tetapi admin dapat mencabutnya kapanpun
-- via POST /v1/admin/users/:userId/verified/gray/revoke dan mengembalikannya
-- via POST /v1/admin/users/:userId/verified/gray/restore.
-- Aditif penuh: tiga kolom nullable baru di "users", tanpa backfill
-- (NULL = tidak pernah di-revoke = badge mengikuti syarat otomatis).

-- AlterTable
ALTER TABLE "users" ADD COLUMN "grayVerifiedRevokedAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "grayVerifiedRevokedBy" TEXT;
ALTER TABLE "users" ADD COLUMN "grayVerifiedRevokeReason" TEXT;
