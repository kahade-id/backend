-- 14.2 relatedArticleId for support tickets
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "relatedArticleId" TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_tickets_relatedArticleId_fkey') THEN
    ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_relatedArticleId_fkey" FOREIGN KEY ("relatedArticleId") REFERENCES "help_center_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "support_tickets_relatedArticleId_idx" ON "support_tickets"("relatedArticleId");
