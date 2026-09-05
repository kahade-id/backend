DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wallet_balance_non_negative'
  ) THEN
    ALTER TABLE "wallets" ADD CONSTRAINT wallet_balance_non_negative CHECK ("balance" >= 0);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wallet_escrow_balance_non_negative'
  ) THEN
    ALTER TABLE "wallets" ADD CONSTRAINT wallet_escrow_balance_non_negative CHECK ("escrowBalance" >= 0);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_value_positive'
  ) THEN
    ALTER TABLE "orders" ADD CONSTRAINT order_value_positive CHECK ("orderValue" > 0);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_fee_non_negative'
  ) THEN
    ALTER TABLE "orders" ADD CONSTRAINT order_fee_non_negative CHECK ("feeAmount" >= 0);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'voucher_valid_dates'
  ) THEN
    ALTER TABLE "vouchers" ADD CONSTRAINT voucher_valid_dates CHECK ("validUntil" > "validFrom");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'idx_user_phone_number'
  ) THEN
    CREATE INDEX idx_user_phone_number ON "users" ("phoneNumber") WHERE "phoneNumber" IS NOT NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'idx_user_email_verified'
  ) THEN
    CREATE INDEX idx_user_email_verified ON "users" ("emailVerified");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'evidence_submitter_xor'
  ) THEN
    ALTER TABLE "dispute_evidences" ADD CONSTRAINT evidence_submitter_xor CHECK (
      ("submittedByRole" IN ('BUYER', 'SELLER') AND "submittedByUserId" IS NOT NULL AND "submittedByAdminId" IS NULL) OR
      ("submittedByRole" = 'ADMIN' AND "submittedByAdminId" IS NOT NULL AND "submittedByUserId" IS NULL) OR
      ("submittedByRole" = 'SYSTEM' AND "submittedByUserId" IS NULL AND "submittedByAdminId" IS NULL)
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'evidence_files_length'
  ) THEN
    ALTER TABLE "dispute_evidences" ADD CONSTRAINT evidence_files_length CHECK (
      array_length("fileUrls", 1) = array_length("fileTypes", 1)
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'idx_voucher_usage_user_voucher'
  ) THEN
    CREATE INDEX idx_voucher_usage_user_voucher ON "voucher_usages" ("voucherId", "userId");
  END IF;
END $$;
