-- SEC-004 FIX: Add privacy settings columns to users table (persisted in DB, Redis as cache)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "profileVisible" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "showOnlineStatus" BOOLEAN NOT NULL DEFAULT true;

-- SEC-005 FIX: Add pushToken column to user_devices table (separate from device_id fingerprint)
ALTER TABLE "user_devices" ADD COLUMN IF NOT EXISTS "pushToken" TEXT;
