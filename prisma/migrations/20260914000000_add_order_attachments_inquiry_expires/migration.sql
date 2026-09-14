-- AlterTable orders: add attachments and sourceInquiryRoomId
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "attachments" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "sourceInquiryRoomId" TEXT;

-- Add FK for sourceInquiryRoomId
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'orders_sourceInquiryRoomId_fkey' AND table_name = 'orders'
  ) THEN
    ALTER TABLE "orders" ADD CONSTRAINT "orders_sourceInquiryRoomId_fkey" FOREIGN KEY ("sourceInquiryRoomId") REFERENCES "chat_rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AlterTable order_extension_requests: add expiresAt
ALTER TABLE "order_extension_requests" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);

-- Index for expiresAt
CREATE INDEX IF NOT EXISTS "order_extension_requests_status_expiresAt_idx" ON "order_extension_requests"("status", "expiresAt");

-- Update existing pending extensions to have expiresAt = createdAt + 2 days
UPDATE "order_extension_requests" SET "expiresAt" = "createdAt" + INTERVAL '2 days' WHERE "status" = 'PENDING' AND "expiresAt" IS NULL;
