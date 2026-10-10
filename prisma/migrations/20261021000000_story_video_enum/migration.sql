-- Story video (2026-10-10): new StoryKind value. Kept in its own migration
-- because PostgreSQL forbids using a freshly added enum value inside the same
-- transaction (the next migration references 'VIDEO' in a CHECK constraint).
ALTER TYPE "StoryKind" ADD VALUE IF NOT EXISTS 'VIDEO';
