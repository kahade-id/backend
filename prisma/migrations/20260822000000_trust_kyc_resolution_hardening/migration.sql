-- Trust/KYC/Resolution hardening.
DROP INDEX IF EXISTS "kyc_requests_ktpNumberHash_key";
CREATE UNIQUE INDEX IF NOT EXISTS "kyc_active_nik_hash_key"
  ON "kyc_requests" ("ktpNumberHash")
  WHERE "status" IN ('PENDING', 'APPROVED', 'REVOKED');

ALTER TABLE "dispute_messages" ALTER COLUMN "senderId" DROP NOT NULL;
DO $$ BEGIN
  ALTER TABLE "dispute_messages" ADD CONSTRAINT "dispute_messages_one_actor_check"
    CHECK (("senderId" IS NOT NULL AND "adminId" IS NULL) OR ("senderId" IS NULL AND "adminId" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
