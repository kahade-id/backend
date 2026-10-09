-- RK-P01: upvote (tepuk tangan) untuk komentar Q&A profil.
-- Additive migration: tambah kolom upvoteCount di profile_question_comments
-- + tabel profile_question_comment_upvotes (unique userId+commentId).

ALTER TABLE "profile_question_comments" ADD COLUMN "upvoteCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "profile_question_comment_upvotes" (
    "id" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profile_question_comment_upvotes_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "profile_question_comment_upvotes" ADD CONSTRAINT "profile_question_comment_upvotes_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "profile_question_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "profile_question_comment_upvotes" ADD CONSTRAINT "profile_question_comment_upvotes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "profile_question_comment_upvotes_userId_commentId_key" ON "profile_question_comment_upvotes"("userId", "commentId");

CREATE INDEX "profile_question_comment_upvotes_commentId_createdAt_id_idx" ON "profile_question_comment_upvotes"("commentId", "createdAt", "id");

CREATE INDEX "profile_question_comment_upvotes_userId_idx" ON "profile_question_comment_upvotes"("userId");

CREATE INDEX "profile_question_comments_questionId_isHidden_upvoteCount_idx" ON "profile_question_comments"("questionId", "isHidden", "upvoteCount");
