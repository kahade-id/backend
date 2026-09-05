-- Idempotent enum additions for audit round 2 findings

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'DISPUTE_ESCALATED'
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'AuditAction')) THEN
    ALTER TYPE "AuditAction" ADD VALUE 'DISPUTE_ESCALATED';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'WITHDRAW_CANCELLED'
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'UserAuditAction')) THEN
    ALTER TYPE "UserAuditAction" ADD VALUE 'WITHDRAW_CANCELLED';
  END IF;
END $$;
