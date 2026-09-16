-- PostgreSQL requires enum additions to be committed before they are used.
-- This constraint therefore lives in a migration after the enum migration.
ALTER TABLE "vouchers" DROP CONSTRAINT IF EXISTS "voucher_discount_xor";
ALTER TABLE "vouchers" ADD CONSTRAINT "voucher_discount_xor"
  CHECK (
    ("voucherType" = 'FEE_DISCOUNT_FLAT' AND "discountAmount" IS NOT NULL AND "discountPercent" IS NULL) OR
    ("voucherType" = 'FEE_DISCOUNT_PERCENT' AND "discountPercent" IS NOT NULL AND "discountAmount" IS NULL) OR
    (
      "voucherType" IN ('WALLET_CASHBACK', 'TOPUP_BONUS') AND (
        ("discountAmount" IS NOT NULL AND "discountPercent" IS NULL) OR
        ("discountAmount" IS NULL AND "discountPercent" IS NOT NULL)
      )
    )
  );
