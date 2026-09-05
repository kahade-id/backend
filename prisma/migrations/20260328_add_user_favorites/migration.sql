-- CreateTable
CREATE TABLE "user_favorites" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "favoriteUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_favorites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_favorites_userId_idx" ON "user_favorites"("userId");

-- CreateIndex
CREATE INDEX "user_favorites_favoriteUserId_idx" ON "user_favorites"("favoriteUserId");

-- CreateIndex
CREATE UNIQUE INDEX "user_favorites_userId_favoriteUserId_key" ON "user_favorites"("userId", "favoriteUserId");

-- AddForeignKey
ALTER TABLE "user_favorites" ADD CONSTRAINT "user_favorites_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_favorites" ADD CONSTRAINT "user_favorites_favoriteUserId_fkey" FOREIGN KEY ("favoriteUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Check constraint: cannot favorite self
ALTER TABLE "user_favorites" ADD CONSTRAINT "favorite_no_self"
  CHECK ("userId" != "favoriteUserId");
