-- Story: 24-hour profile-saver content, interactions, highlights and moderation.
-- Additive migration; reports deliberately retain a textual storyId so the
-- moderation queue survives Story/media hard deletion.

DO $$ BEGIN
  CREATE TYPE "StoryKind" AS ENUM ('IMAGE', 'TEXT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "StoryReportCategory" AS ENUM ('SPAM', 'HARASSMENT', 'OFFENSIVE', 'IRRELEVANT', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "StoryReportStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'RESOLVED_ACTION', 'RESOLVED_DISMISSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TYPE "UserAuditAction" ADD VALUE IF NOT EXISTS 'STORY_REPORTED';

CREATE TABLE "story_media_uploads" (
  "id" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "fileKey" VARCHAR(512) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "story_media_uploads_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "story_media_uploads_fileKey_key" ON "story_media_uploads"("fileKey");
CREATE INDEX "story_media_uploads_authorId_expiresAt_idx" ON "story_media_uploads"("authorId", "expiresAt");
CREATE INDEX "story_media_uploads_expiresAt_idx" ON "story_media_uploads"("expiresAt");
ALTER TABLE "story_media_uploads"
  ADD CONSTRAINT "story_media_uploads_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "stories" (
  "id" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "kind" "StoryKind" NOT NULL,
  "mediaUrl" VARCHAR(512),
  "mediaKey" VARCHAR(512),
  "textContent" VARCHAR(200),
  "backgroundColor" VARCHAR(7),
  "audience" JSONB NOT NULL,
  "productTags" JSONB NOT NULL,
  "priceSticker" JSONB,
  "askStock" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "expiryNotifiedAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),
  "hiddenAt" TIMESTAMP(3),
  "hiddenUntil" TIMESTAMP(3),
  "hiddenReason" VARCHAR(500),
  "hiddenByAdminId" VARCHAR(100),
  CONSTRAINT "stories_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stories_expiry_after_created_check" CHECK ("expiresAt" > "createdAt"),
  CONSTRAINT "stories_kind_payload_check" CHECK (
    ("kind" = 'IMAGE' AND "mediaKey" IS NOT NULL AND "backgroundColor" IS NULL)
    OR
    ("kind" = 'TEXT' AND "mediaUrl" IS NULL AND "mediaKey" IS NULL AND "textContent" IS NOT NULL AND "backgroundColor" IS NOT NULL)
  ),
  CONSTRAINT "stories_json_payload_check" CHECK (
    jsonb_typeof("audience") = 'object' AND jsonb_typeof("productTags") = 'array'
  ),
  CONSTRAINT "stories_hidden_until_check" CHECK ("hiddenUntil" IS NULL OR "hiddenAt" IS NOT NULL)
);
CREATE INDEX "stories_authorId_expiresAt_createdAt_idx" ON "stories"("authorId", "expiresAt", "createdAt");
CREATE INDEX "stories_expiresAt_idx" ON "stories"("expiresAt");
CREATE INDEX "stories_deletedAt_idx" ON "stories"("deletedAt");
CREATE INDEX "stories_hiddenAt_hiddenUntil_idx" ON "stories"("hiddenAt", "hiddenUntil");
ALTER TABLE "stories"
  ADD CONSTRAINT "stories_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "story_views" (
  "id" TEXT NOT NULL,
  "storyId" TEXT NOT NULL,
  "viewerId" TEXT NOT NULL,
  "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "story_views_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "story_views_storyId_viewerId_key" ON "story_views"("storyId", "viewerId");
CREATE INDEX "story_views_storyId_viewedAt_viewerId_idx" ON "story_views"("storyId", "viewedAt", "viewerId");
CREATE INDEX "story_views_viewerId_viewedAt_idx" ON "story_views"("viewerId", "viewedAt");
ALTER TABLE "story_views"
  ADD CONSTRAINT "story_views_storyId_fkey"
  FOREIGN KEY ("storyId") REFERENCES "stories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "story_views"
  ADD CONSTRAINT "story_views_viewerId_fkey"
  FOREIGN KEY ("viewerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "story_reactions" (
  "id" TEXT NOT NULL,
  "storyId" TEXT NOT NULL,
  "viewerId" TEXT NOT NULL,
  "emoji" VARCHAR(16) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "story_reactions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "story_reactions_storyId_viewerId_key" ON "story_reactions"("storyId", "viewerId");
CREATE INDEX "story_reactions_storyId_createdAt_idx" ON "story_reactions"("storyId", "createdAt");
CREATE INDEX "story_reactions_viewerId_idx" ON "story_reactions"("viewerId");
ALTER TABLE "story_reactions"
  ADD CONSTRAINT "story_reactions_storyId_fkey"
  FOREIGN KEY ("storyId") REFERENCES "stories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "story_reactions"
  ADD CONSTRAINT "story_reactions_viewerId_fkey"
  FOREIGN KEY ("viewerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "story_mutes" (
  "id" TEXT NOT NULL,
  "viewerId" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "story_mutes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "story_mutes_viewerId_authorId_key" ON "story_mutes"("viewerId", "authorId");
CREATE INDEX "story_mutes_viewerId_createdAt_idx" ON "story_mutes"("viewerId", "createdAt");
ALTER TABLE "story_mutes"
  ADD CONSTRAINT "story_mutes_viewerId_fkey"
  FOREIGN KEY ("viewerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "story_mutes"
  ADD CONSTRAINT "story_mutes_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "story_reports" (
  "id" TEXT NOT NULL,
  "storyId" VARCHAR(100) NOT NULL,
  "authorId" VARCHAR(100) NOT NULL,
  "reporterId" TEXT NOT NULL,
  "category" "StoryReportCategory" NOT NULL,
  "note" VARCHAR(500),
  "storySnapshot" JSONB NOT NULL,
  "status" "StoryReportStatus" NOT NULL DEFAULT 'OPEN',
  "internalNote" VARCHAR(1000),
  "reviewedByAdminId" VARCHAR(100),
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "story_reports_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "story_reports_storyId_reporterId_key" ON "story_reports"("storyId", "reporterId");
CREATE INDEX "story_reports_status_createdAt_idx" ON "story_reports"("status", "createdAt");
CREATE INDEX "story_reports_storyId_createdAt_idx" ON "story_reports"("storyId", "createdAt");
CREATE INDEX "story_reports_authorId_createdAt_idx" ON "story_reports"("authorId", "createdAt");
CREATE INDEX "story_reports_reporterId_createdAt_idx" ON "story_reports"("reporterId", "createdAt");
ALTER TABLE "story_reports"
  ADD CONSTRAINT "story_reports_reporterId_fkey"
  FOREIGN KEY ("reporterId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "story_highlights" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "title" VARCHAR(24) NOT NULL,
  "coverStoryId" VARCHAR(100),
  "storyIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "stories" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "story_highlights_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "story_highlights_userId_createdAt_idx" ON "story_highlights"("userId", "createdAt");
ALTER TABLE "story_highlights"
  ADD CONSTRAINT "story_highlights_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "story_feature_bans" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "bannedUntil" TIMESTAMP(3),
  "reason" VARCHAR(500) NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "bannedByAdminId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "story_feature_bans_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "story_feature_bans_userId_key" ON "story_feature_bans"("userId");
CREATE INDEX "story_feature_bans_isActive_bannedUntil_idx" ON "story_feature_bans"("isActive", "bannedUntil");
ALTER TABLE "story_feature_bans"
  ADD CONSTRAINT "story_feature_bans_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "story_feature_bans"
  ADD CONSTRAINT "story_feature_bans_bannedByAdminId_fkey"
  FOREIGN KEY ("bannedByAdminId") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Story reply linkage is intentionally non-FK to preserve chat history after
-- Story expiry hard-deletion.
ALTER TABLE "chat_messages" ADD COLUMN "storyId" VARCHAR(100);
CREATE INDEX "chat_messages_storyId_createdAt_idx" ON "chat_messages"("storyId", "createdAt");
