-- Fitur "lokasi presisi tiap aksi sensitif" (2026-09-27).
-- Additive-only: tabel baru `action_locations` + enum `ActionLocationType`.
-- Tidak ada perubahan kolom/tabel existing; alur escrow/wallet tidak tersentuh.
-- Lokasi boleh NULL bila user menolak izin GPS (kolom locationDenied=true),
-- aksi utama tidak pernah diblokir oleh kegagalan tulis log ini.

-- CreateEnum
CREATE TYPE "ActionLocationType" AS ENUM ('ORDER_CREATE', 'ORDER_PAY', 'ORDER_CONFIRM_RECEIPT', 'ORDER_CANCEL', 'WALLET_TOPUP', 'WALLET_WITHDRAW', 'WALLET_TRANSFER', 'WALLET_PIN_CHANGE', 'DISPUTE_OPEN', 'DISPUTE_APPEAL', 'ACCOUNT_DELETE');

-- CreateTable
CREATE TABLE "action_locations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "actionType" "ActionLocationType" NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "accuracy" DOUBLE PRECISION,
    "source" TEXT,
    "locationDenied" BOOLEAN NOT NULL DEFAULT false,
    "ipAddress" TEXT,
    "deviceId" TEXT,
    "suspicious" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "action_locations_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "action_locations" ADD CONSTRAINT "action_locations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "action_locations_userId_createdAt_idx" ON "action_locations"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "action_locations_referenceType_referenceId_idx" ON "action_locations"("referenceType", "referenceId");
