-- CreateEnum
CREATE TYPE "OrderLinkStatus" AS ENUM ('ACTIVE', 'ACCEPTED', 'EXPIRED', 'CANCELLED');
CREATE TYPE "DeliveryProofStatus" AS ENUM ('SUBMITTED', 'ACCEPTED', 'REJECTED', 'AUTO_RELEASED');
CREATE TYPE "CampaignType" AS ENUM ('FEE_PROMO', 'SUBSCRIPTION_DISCOUNT', 'CASHBACK');
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ENDED');

-- AlterEnum
ALTER TYPE "UserAuditAction" ADD VALUE 'ORDER_DELIVERED';
ALTER TYPE "UserAuditAction" ADD VALUE 'ORDER_DELIVERY_CONFIRMED';
ALTER TYPE "UserAuditAction" ADD VALUE 'ORDER_LINK_CREATED';
ALTER TYPE "UserAuditAction" ADD VALUE 'ORDER_LINK_ACCEPTED';

-- AlterTable: orders
ALTER TABLE "orders" ADD COLUMN "orderLinkId" TEXT;

-- CreateTable: order_links
CREATE TABLE "order_links" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "creatorRole" "UserRole" NOT NULL,
    "title" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "orderType" "OrderType" NOT NULL,
    "orderValue" BIGINT NOT NULL,
    "feeResponsibility" "FeeResponsibility" NOT NULL,
    "deliveryDeadlineDays" INTEGER NOT NULL,
    "counterpartUsername" TEXT,
    "status" "OrderLinkStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable: delivery_proofs
CREATE TABLE "delivery_proofs" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "submittedBy" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "fileUrls" TEXT[],
    "linkUrls" TEXT[],
    "status" "DeliveryProofStatus" NOT NULL DEFAULT 'SUBMITTED',
    "reviewWindowEnd" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "rejectionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_proofs_pkey" PRIMARY KEY ("id")
);

-- CreateTable: rating_replies
CREATE TABLE "rating_replies" (
    "id" TEXT NOT NULL,
    "ratingId" TEXT NOT NULL,
    "replierId" TEXT NOT NULL,
    "content" VARCHAR(500) NOT NULL,
    "isHidden" BOOLEAN NOT NULL DEFAULT false,
    "hiddenAt" TIMESTAMP(3),
    "hiddenBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rating_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable: profile_questions
CREATE TABLE "profile_questions" (
    "id" TEXT NOT NULL,
    "askerId" TEXT NOT NULL,
    "receiverId" TEXT NOT NULL,
    "question" VARCHAR(500) NOT NULL,
    "answer" VARCHAR(1000),
    "answeredAt" TIMESTAMP(3),
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "isHidden" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profile_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable: campaigns
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "CampaignType" NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "discountValue" BIGINT,
    "discountPercent" DECIMAL(5,2),
    "maxDiscount" BIGINT,
    "freeTransactions" INTEGER,
    "targetAudience" TEXT,
    "maxRedemptions" INTEGER,
    "currentRedemptions" INTEGER NOT NULL DEFAULT 0,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable: scheduled_withdrawals
CREATE TABLE "scheduled_withdrawals" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "minAmount" BIGINT NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastExecutedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "order_links_linkId_key" ON "order_links"("linkId");
CREATE UNIQUE INDEX "order_links_token_key" ON "order_links"("token");
CREATE INDEX "order_links_creatorId_idx" ON "order_links"("creatorId");
CREATE INDEX "order_links_token_idx" ON "order_links"("token");
CREATE INDEX "order_links_status_idx" ON "order_links"("status");
CREATE INDEX "order_links_status_expiresAt_idx" ON "order_links"("status", "expiresAt");

CREATE INDEX "delivery_proofs_orderId_idx" ON "delivery_proofs"("orderId");
CREATE INDEX "delivery_proofs_status_idx" ON "delivery_proofs"("status");
CREATE INDEX "delivery_proofs_status_reviewWindowEnd_idx" ON "delivery_proofs"("status", "reviewWindowEnd");

CREATE UNIQUE INDEX "rating_replies_ratingId_key" ON "rating_replies"("ratingId");
CREATE INDEX "rating_replies_ratingId_idx" ON "rating_replies"("ratingId");
CREATE INDEX "rating_replies_replierId_idx" ON "rating_replies"("replierId");

CREATE INDEX "profile_questions_receiverId_idx" ON "profile_questions"("receiverId");
CREATE INDEX "profile_questions_askerId_idx" ON "profile_questions"("askerId");
CREATE INDEX "profile_questions_receiverId_isPublic_isHidden_idx" ON "profile_questions"("receiverId", "isPublic", "isHidden");

CREATE UNIQUE INDEX "campaigns_campaignId_key" ON "campaigns"("campaignId");
CREATE INDEX "campaigns_status_idx" ON "campaigns"("status");
CREATE INDEX "campaigns_status_startsAt_endsAt_idx" ON "campaigns"("status", "startsAt", "endsAt");
CREATE INDEX "campaigns_type_idx" ON "campaigns"("type");

CREATE UNIQUE INDEX "scheduled_withdrawals_userId_dayOfWeek_key" ON "scheduled_withdrawals"("userId", "dayOfWeek");
CREATE INDEX "scheduled_withdrawals_userId_idx" ON "scheduled_withdrawals"("userId");
CREATE INDEX "scheduled_withdrawals_isActive_dayOfWeek_idx" ON "scheduled_withdrawals"("isActive", "dayOfWeek");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_orderLinkId_fkey" FOREIGN KEY ("orderLinkId") REFERENCES "order_links"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "order_links" ADD CONSTRAINT "order_links_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_proofs" ADD CONSTRAINT "delivery_proofs_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rating_replies" ADD CONSTRAINT "rating_replies_ratingId_fkey" FOREIGN KEY ("ratingId") REFERENCES "ratings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "profile_questions" ADD CONSTRAINT "profile_questions_askerId_fkey" FOREIGN KEY ("askerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "profile_questions" ADD CONSTRAINT "profile_questions_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
