-- Backfill: This is a placeholder migration.
-- PII encryption backfill must be done via application-level script
-- because it requires access to the encryption key (AES) and HMAC secret
-- which are not available in raw SQL.
--
-- Run the backfill script after deploying:
--   npx ts-node scripts/backfill-pii-encryption.ts
--
-- This migration is intentionally empty to maintain migration ordering.
SELECT 1;
