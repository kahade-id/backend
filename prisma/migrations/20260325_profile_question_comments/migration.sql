-- CreateTable
CREATE TABLE "profile_question_comments" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "parentId" TEXT,
    "content" VARCHAR(1000) NOT NULL,
    "isHidden" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profile_question_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "profile_question_comments_questionId_idx" ON "profile_question_comments"("questionId");

-- CreateIndex
CREATE INDEX "profile_question_comments_authorId_idx" ON "profile_question_comments"("authorId");

-- CreateIndex
CREATE INDEX "profile_question_comments_parentId_idx" ON "profile_question_comments"("parentId");

-- AddForeignKey
ALTER TABLE "profile_question_comments" ADD CONSTRAINT "profile_question_comments_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "profile_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_question_comments" ADD CONSTRAINT "profile_question_comments_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_question_comments" ADD CONSTRAINT "profile_question_comments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "profile_question_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
