-- Add missing rolloutPercent column to campaigns table.
-- The column was declared in schema.prisma but never created in any migration,
-- causing GET /admin/campaigns to fail with Prisma P2022
-- (column "campaigns.rolloutPercent" does not exist).
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "rolloutPercent" INTEGER;
