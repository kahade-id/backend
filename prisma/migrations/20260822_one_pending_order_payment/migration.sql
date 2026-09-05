-- A waiting-payment order may have at most one live escrow payment.
-- Historical terminal payments remain allowed; only PENDING escrow payments are constrained.
-- Keep the newest pending attempt and close older duplicates before creating the index.
WITH ranked AS (
  SELECT "id",
         ROW_NUMBER() OVER (PARTITION BY "orderId" ORDER BY "createdAt" DESC, "id" DESC) AS rn
  FROM "payment_transactions"
  WHERE "orderId" IS NOT NULL
    AND "purpose" = 'ORDER_ESCROW'
    AND "status" = 'PENDING'
)
UPDATE "payment_transactions" AS p
SET "status" = 'EXPIRED',
    "failedAt" = COALESCE("failedAt", NOW())
FROM ranked AS r
WHERE p."id" = r."id" AND r.rn > 1;

CREATE UNIQUE INDEX "payment_one_pending_order_escrow"
  ON "payment_transactions" ("orderId")
  WHERE "orderId" IS NOT NULL
    AND "purpose" = 'ORDER_ESCROW'
    AND "status" = 'PENDING';
