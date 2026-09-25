-- Auth rework (2026-09-26): lokasi presisi pada momen sensitif auth.
-- Aditif penuh: tabel baru, tidak menyentuh tabel/data lama.

-- CreateTable
CREATE TABLE "auth_location_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "event" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION,
    "ipAddress" TEXT,
    "deviceId" TEXT,
    "suspicious" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_location_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "auth_location_logs_userId_createdAt_idx" ON "auth_location_logs"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "auth_location_logs_event_createdAt_idx" ON "auth_location_logs"("event", "createdAt");

-- AddForeignKey
ALTER TABLE "auth_location_logs" ADD CONSTRAINT "auth_location_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
