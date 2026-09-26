-- S-4: share counter untuk analitik "berapa kali dibagikan" (GET /v1/showcase/:id/share)
ALTER TABLE "user_showcases" ADD COLUMN "shareCount" INTEGER NOT NULL DEFAULT 0;
