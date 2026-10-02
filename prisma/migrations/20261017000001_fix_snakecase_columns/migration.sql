-- CRITICAL FIX: migrasi 20261016000000 membuat kolom dengan snake_case
-- (dispute_id, idempotency_key, dll.) padahal schema Prisma memakai camelCase
-- tanpa @map (disputeId, idempotencyKey, dll.). Akibatnya SEMUA query Prisma
-- ke tabel-tabel ini gagal dengan P2022 "column does not exist".
-- Migrasi ini me-rename kolom ke nama yang diharapkan Prisma.
-- PostgreSQL otomatis memperbarui FK constraint & index yang merujuk kolom lama.

-- 1. wallet_transactions.idempotency_key -> idempotencyKey (SEC-203)
ALTER TABLE "wallet_transactions" RENAME COLUMN "idempotency_key" TO "idempotencyKey";
ALTER INDEX "wallet_transactions_idempotency_key_unique" RENAME TO "wallet_transactions_idempotencyKey_unique";

-- 2. showcase_comments soft-delete (FAL-027)
ALTER TABLE "showcase_comments" RENAME COLUMN "delete_reason" TO "deleteReason";
ALTER TABLE "showcase_comments" RENAME COLUMN "deleted_at" TO "deletedAt";
ALTER TABLE "showcase_comments" RENAME COLUMN "deleted_by" TO "deletedBy";

-- 3. showcase_comment_reactions
ALTER TABLE "showcase_comment_reactions" RENAME COLUMN "comment_id" TO "commentId";
ALTER TABLE "showcase_comment_reactions" RENAME COLUMN "user_id" TO "userId";
ALTER TABLE "showcase_comment_reactions" RENAME COLUMN "created_at" TO "createdAt";
ALTER INDEX "showcase_comment_reactions_comment_id_user_id_unique" RENAME TO "showcase_comment_reactions_commentId_userId_unique";

-- 4. admin_action_approvals (dual control)
ALTER TABLE "admin_action_approvals" RENAME COLUMN "action_type" TO "actionType";
ALTER TABLE "admin_action_approvals" RENAME COLUMN "target_id" TO "targetId";
ALTER TABLE "admin_action_approvals" RENAME COLUMN "amount_sen" TO "amountSen";
ALTER TABLE "admin_action_approvals" RENAME COLUMN "idempotency_key" TO "idempotencyKey";
ALTER TABLE "admin_action_approvals" RENAME COLUMN "proposed_by" TO "proposedBy";
ALTER TABLE "admin_action_approvals" RENAME COLUMN "proposed_at" TO "proposedAt";
ALTER TABLE "admin_action_approvals" RENAME COLUMN "decided_by" TO "decidedBy";
ALTER TABLE "admin_action_approvals" RENAME COLUMN "decided_at" TO "decidedAt";
ALTER TABLE "admin_action_approvals" RENAME COLUMN "executed_at" TO "executedAt";
ALTER TABLE "admin_action_approvals" RENAME COLUMN "expires_at" TO "expiresAt";
ALTER TABLE "admin_action_approvals" RENAME COLUMN "reject_reason" TO "rejectReason";
ALTER INDEX "admin_action_approvals_idempotency_key_unique" RENAME TO "admin_action_approvals_idempotencyKey_unique";
ALTER INDEX "admin_action_approvals_status_expires_at_idx" RENAME TO "admin_action_approvals_status_expiresAt_idx";
ALTER INDEX "admin_action_approvals_proposed_by_proposed_at_idx" RENAME TO "admin_action_approvals_proposedBy_proposedAt_idx";

-- 5. admin_step_up_tokens
ALTER TABLE "admin_step_up_tokens" RENAME COLUMN "token_hash" TO "tokenHash";
ALTER TABLE "admin_step_up_tokens" RENAME COLUMN "admin_id" TO "adminId";
ALTER TABLE "admin_step_up_tokens" RENAME COLUMN "target_id" TO "targetId";
ALTER TABLE "admin_step_up_tokens" RENAME COLUMN "expires_at" TO "expiresAt";
ALTER TABLE "admin_step_up_tokens" RENAME COLUMN "used_at" TO "usedAt";
ALTER TABLE "admin_step_up_tokens" RENAME COLUMN "created_at" TO "createdAt";
ALTER INDEX "admin_step_up_tokens_token_hash_unique" RENAME TO "admin_step_up_tokens_tokenHash_unique";
ALTER INDEX "admin_step_up_tokens_admin_id_created_at_idx" RENAME TO "admin_step_up_tokens_adminId_createdAt_idx";

-- 6. dispute_settlement_intents
ALTER TABLE "dispute_settlement_intents" RENAME COLUMN "dispute_id" TO "disputeId";
ALTER TABLE "dispute_settlement_intents" RENAME COLUMN "buyer_amount_sen" TO "buyerAmountSen";
ALTER TABLE "dispute_settlement_intents" RENAME COLUMN "seller_amount_sen" TO "sellerAmountSen";
ALTER TABLE "dispute_settlement_intents" RENAME COLUMN "attempt_count" TO "attemptCount";
ALTER TABLE "dispute_settlement_intents" RENAME COLUMN "last_error" TO "lastError";
ALTER TABLE "dispute_settlement_intents" RENAME COLUMN "created_at" TO "createdAt";
ALTER TABLE "dispute_settlement_intents" RENAME COLUMN "updated_at" TO "updatedAt";
ALTER TABLE "dispute_settlement_intents" RENAME COLUMN "claimed_at" TO "claimedAt";
ALTER TABLE "dispute_settlement_intents" RENAME COLUMN "done_at" TO "doneAt";
ALTER INDEX "dispute_settlement_intents_dispute_id_unique" RENAME TO "dispute_settlement_intents_disputeId_unique";
ALTER INDEX "dispute_settlement_intents_status_updated_at_idx" RENAME TO "dispute_settlement_intents_status_updatedAt_idx";
-- FK constraint name masih menyebut dispute_id tapi tetap valid (PostgreSQL update referensinya otomatis).
