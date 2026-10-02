-- Audit 2026-10-03: perbaikan keamanan & integrasi
-- Timestamp 20261016000000 — SETELAH 20261015000000_chat_poll_as_message.

-- SEC-203: kolom idempotencyKey dedikasi di wallet_transactions (atomic via unique).
ALTER TABLE "wallet_transactions" ADD COLUMN "idempotency_key" TEXT;
CREATE UNIQUE INDEX "wallet_transactions_idempotency_key_unique" ON "wallet_transactions"("idempotency_key");

-- FAL-027: soft-delete komentar showcase (ganti hard-delete).
ALTER TABLE "showcase_comments" ADD COLUMN "deleted_at" TIMESTAMPTZ(6);
ALTER TABLE "showcase_comments" ADD COLUMN "deleted_by" VARCHAR(100);
ALTER TABLE "showcase_comments" ADD COLUMN "delete_reason" TEXT;

-- BFE-117 / FAL-009: reaksi like/dislike komentar showcase (persisten per user).
CREATE TABLE "showcase_comment_reactions" (
  "id" TEXT NOT NULL,
  "comment_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "value" INTEGER NOT NULL CHECK ("value" IN (1, -1)),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "showcase_comment_reactions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "showcase_comment_reactions_comment_id_fkey"
    FOREIGN KEY ("comment_id") REFERENCES "showcase_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "showcase_comment_reactions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "showcase_comment_reactions_comment_id_user_id_unique"
  ON "showcase_comment_reactions"("comment_id", "user_id");
CREATE INDEX "showcase_comment_reactions_comment_id_idx"
  ON "showcase_comment_reactions"("comment_id");

-- SEC-104: intent settlement sengketa no-wallet yang durable (dibuat di dalam tx putusan).
CREATE TABLE "dispute_settlement_intents" (
  "id" TEXT NOT NULL,
  "dispute_id" TEXT NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "buyer_amount_sen" BIGINT NOT NULL DEFAULT 0,
  "seller_amount_sen" BIGINT NOT NULL DEFAULT 0,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimed_at" TIMESTAMPTZ(6),
  "done_at" TIMESTAMPTZ(6),
  CONSTRAINT "dispute_settlement_intents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dispute_settlement_intents_dispute_id_fkey"
    FOREIGN KEY ("dispute_id") REFERENCES "disputes"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "dispute_settlement_intents_dispute_id_unique"
  ON "dispute_settlement_intents"("dispute_id");
CREATE INDEX "dispute_settlement_intents_status_updated_at_idx"
  ON "dispute_settlement_intents"("status", "updated_at");

-- SEC-503: token step-up re-auth admin (single-use, TTL pendek, terikat aksi+target).
-- adminId String polos tanpa FK, mengikuti konvensi repo.
CREATE TABLE "admin_step_up_tokens" (
  "id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "admin_id" TEXT NOT NULL,
  "action" VARCHAR(120) NOT NULL,
  "target_id" TEXT,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "used_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_step_up_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "admin_step_up_tokens_token_hash_unique"
  ON "admin_step_up_tokens"("token_hash");
CREATE INDEX "admin_step_up_tokens_admin_id_created_at_idx"
  ON "admin_step_up_tokens"("admin_id", "created_at");

-- SEC-501/502/601/602 + BAD-001: dual control untuk aksi sensitif admin.
CREATE TABLE "admin_action_approvals" (
  "id" TEXT NOT NULL,
  "action_type" VARCHAR(120) NOT NULL,
  "target_id" TEXT,
  "payload" JSONB NOT NULL,
  "amount_sen" BIGINT,
  "idempotency_key" TEXT NOT NULL,
  "proposed_by" TEXT NOT NULL,
  "proposed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "decided_by" TEXT,
  "decided_at" TIMESTAMPTZ(6),
  "executed_at" TIMESTAMPTZ(6),
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "reject_reason" TEXT,
  CONSTRAINT "admin_action_approvals_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "admin_action_approvals_idempotency_key_unique"
  ON "admin_action_approvals"("idempotency_key");
CREATE INDEX "admin_action_approvals_status_expires_at_idx"
  ON "admin_action_approvals"("status", "expires_at");
CREATE INDEX "admin_action_approvals_proposed_by_proposed_at_idx"
  ON "admin_action_approvals"("proposed_by", "proposed_at");
