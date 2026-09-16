-- 14.2 relatedArticleId for support tickets
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "relatedArticleId" TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_tickets_relatedArticleId_fkey')
     AND to_regclass('public.faq_items') IS NOT NULL THEN
    ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_relatedArticleId_fkey" FOREIGN KEY ("relatedArticleId") REFERENCES "faq_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "support_tickets_relatedArticleId_idx" ON "support_tickets"("relatedArticleId");
