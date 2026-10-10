-- Story video (2026-10-10): poster thumbnail + duration on tickets and stories,
-- and a payload check that accepts VIDEO (mediaKey required, no background).

ALTER TABLE "story_media_uploads"
  ADD COLUMN "kind" "StoryKind" NOT NULL DEFAULT 'IMAGE',
  ADD COLUMN "thumbnailKey" VARCHAR(512),
  ADD COLUMN "durationMs" INTEGER,
  ADD COLUMN "width" INTEGER,
  ADD COLUMN "height" INTEGER;

ALTER TABLE "stories"
  ADD COLUMN "thumbnailKey" VARCHAR(512),
  ADD COLUMN "durationMs" INTEGER;

ALTER TABLE "stories" DROP CONSTRAINT IF EXISTS "stories_kind_payload_check";
ALTER TABLE "stories" ADD CONSTRAINT "stories_kind_payload_check" CHECK (
  ("kind" = 'IMAGE' AND "mediaKey" IS NOT NULL AND "backgroundColor" IS NULL AND "thumbnailKey" IS NULL AND "durationMs" IS NULL)
  OR
  ("kind" = 'VIDEO' AND "mediaKey" IS NOT NULL AND "backgroundColor" IS NULL AND "durationMs" IS NOT NULL AND "durationMs" > 0)
  OR
  ("kind" = 'TEXT' AND "mediaUrl" IS NULL AND "mediaKey" IS NULL AND "thumbnailKey" IS NULL AND "durationMs" IS NULL AND "textContent" IS NOT NULL AND "backgroundColor" IS NOT NULL)
);
