-- Create FAQ and Transaction Templates tables (missing from initial migration)

-- ═══════════════════════════════════════════════════════════════════════════
-- FAQ Categories
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "faq_categories" (
  "id"            TEXT NOT NULL,
  "slug"          TEXT NOT NULL,
  "name"          TEXT NOT NULL,
  "nameEn"        TEXT,
  "description"   TEXT,
  "descriptionEn" TEXT,
  "icon"          TEXT,
  "sortOrder"     INTEGER NOT NULL DEFAULT 0,
  "isActive"      BOOLEAN NOT NULL DEFAULT true,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,

  CONSTRAINT "faq_categories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "faq_categories_slug_key" ON "faq_categories"("slug");
CREATE INDEX IF NOT EXISTS "faq_categories_isActive_sortOrder_idx" ON "faq_categories"("isActive", "sortOrder");

-- ═══════════════════════════════════════════════════════════════════════════
-- FAQ Items
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "faq_items" (
  "id"          TEXT NOT NULL,
  "categoryId"  TEXT NOT NULL,
  "question"    TEXT NOT NULL,
  "questionEn"  TEXT,
  "answer"      TEXT NOT NULL,
  "answerEn"    TEXT,
  "sortOrder"   INTEGER NOT NULL DEFAULT 0,
  "isActive"    BOOLEAN NOT NULL DEFAULT true,
  "viewCount"   INTEGER NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "faq_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "faq_items_categoryId_fkey" FOREIGN KEY ("categoryId")
    REFERENCES "faq_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "faq_items_categoryId_idx" ON "faq_items"("categoryId");
CREATE INDEX IF NOT EXISTS "faq_items_isActive_sortOrder_idx" ON "faq_items"("isActive", "sortOrder");
CREATE INDEX IF NOT EXISTS "faq_items_viewCount_idx" ON "faq_items"("viewCount");

-- ═══════════════════════════════════════════════════════════════════════════
-- Transaction Templates
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "transaction_templates" (
  "id"                    TEXT NOT NULL,
  "userId"                TEXT NOT NULL,
  "name"                  TEXT NOT NULL,
  "title"                 TEXT NOT NULL,
  "description"           TEXT,
  "orderType"             "OrderType" NOT NULL,
  "orderValue"            BIGINT NOT NULL,
  "feeResponsibility"     "FeeResponsibility" NOT NULL DEFAULT 'BUYER',
  "deliveryDeadlineDays"  INTEGER NOT NULL DEFAULT 3,
  "isDefault"             BOOLEAN NOT NULL DEFAULT false,
  "usageCount"            INTEGER NOT NULL DEFAULT 0,
  "lastUsedAt"            TIMESTAMP(3),
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,

  CONSTRAINT "transaction_templates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "transaction_templates_userId_idx" ON "transaction_templates"("userId");
CREATE INDEX IF NOT EXISTS "transaction_templates_userId_isDefault_idx" ON "transaction_templates"("userId", "isDefault");
