-- Mode tanpa-wallet (BI-safe): tipe notifikasi untuk escrow yang ditahan
-- karena seller belum mendaftarkan rekening bank.
-- Additive-only: ALTER TYPE ... ADD VALUE tidak menyentuh data existing.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ESCROW_HELD_NO_BANK';

-- Status CANCELLED untuk disbursement yang dibatalkan (mis. legacy payout
-- yang debitnya dikompensasi karena rekening dihapus sebelum transfer).
ALTER TYPE "EscrowDisbursementStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
