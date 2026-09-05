-- Bind future refresh sessions to the app device identifier so removing a
-- device can revoke its sessions deterministically. Existing sessions remain
-- NULL and are revoked conservatively when a user removes any device.
ALTER TABLE "user_sessions" ADD COLUMN "deviceId" TEXT;

CREATE INDEX "user_sessions_userId_deviceId_idx"
  ON "user_sessions"("userId", "deviceId");
