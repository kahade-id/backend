-- OPS: app_settings + app_setting_audits (additive-only)
CREATE TABLE "app_settings" (
  "key" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "isSecret" BOOLEAN NOT NULL DEFAULT true,
  "label" TEXT,
  "updatedBy" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "app_setting_audits" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "changedBy" TEXT NOT NULL,
  "valueHint" TEXT,
  "success" BOOLEAN,
  "detail" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "app_setting_audits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "app_setting_audits_key_createdAt_idx" ON "app_setting_audits"("key", "createdAt");
