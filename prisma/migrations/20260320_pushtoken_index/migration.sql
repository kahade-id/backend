-- Migration: Add index on user_devices.push_token for registerDevice dedup lookup
-- Prevents full-table scan on every push token registration/update.
-- Partial index: only non-null tokens (most rows have null pushToken — login devices).

CREATE INDEX IF NOT EXISTS "user_devices_push_token_idx"
  ON "user_devices" ("pushToken")
  WHERE "pushToken" IS NOT NULL;
