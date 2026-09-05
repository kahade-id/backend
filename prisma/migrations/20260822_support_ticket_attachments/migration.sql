-- Preserve validated support-ticket attachment keys instead of silently dropping them.
ALTER TABLE "support_tickets"
  ADD COLUMN IF NOT EXISTS "attachments" JSONB NOT NULL DEFAULT '[]'::jsonb;
