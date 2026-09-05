-- Follow system
CREATE TABLE "follows" (
    "id" TEXT NOT NULL,
    "followerId" TEXT NOT NULL,
    "followingId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "follows_pkey" PRIMARY KEY ("id")
);

-- User social links
CREATE TABLE "user_links" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" VARCHAR(30) NOT NULL,
    "url" VARCHAR(500) NOT NULL,
    "label" VARCHAR(50),
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_links_pkey" PRIMARY KEY ("id")
);

-- New User fields
ALTER TABLE "users" ADD COLUMN "headerUrl" TEXT;
ALTER TABLE "users" ADD COLUMN "usernameChangedAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "contactEmail" TEXT;
ALTER TABLE "users" ADD COLUMN "contactPhone" TEXT;
ALTER TABLE "users" ADD COLUMN "showContactEmail" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "showContactPhone" BOOLEAN NOT NULL DEFAULT false;

-- Increase bio from 160 to 500 chars
ALTER TABLE "users" ALTER COLUMN "bio" TYPE VARCHAR(500);

-- Follow indexes and constraints
CREATE UNIQUE INDEX "follows_followerId_followingId_key" ON "follows"("followerId", "followingId");
CREATE INDEX "follows_followerId_idx" ON "follows"("followerId");
CREATE INDEX "follows_followingId_idx" ON "follows"("followingId");

-- Follow no-self constraint
ALTER TABLE "follows" ADD CONSTRAINT "follow_no_self" CHECK ("followerId" != "followingId");

-- Follow foreign keys
ALTER TABLE "follows" ADD CONSTRAINT "follows_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "follows" ADD CONSTRAINT "follows_followingId_fkey" FOREIGN KEY ("followingId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- UserLink indexes and foreign keys
CREATE INDEX "user_links_userId_idx" ON "user_links"("userId");
ALTER TABLE "user_links" ADD CONSTRAINT "user_links_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

