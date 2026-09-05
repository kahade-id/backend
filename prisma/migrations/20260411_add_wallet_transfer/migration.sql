-- AlterEnum: WalletTransactionType
ALTER TYPE "WalletTransactionType" ADD VALUE 'TRANSFER_SENT';
ALTER TYPE "WalletTransactionType" ADD VALUE 'TRANSFER_RECEIVED';

-- AlterEnum: NotificationType
ALTER TYPE "NotificationType" ADD VALUE 'WALLET_TRANSFER_SENT';
ALTER TYPE "NotificationType" ADD VALUE 'WALLET_TRANSFER_RECEIVED';

-- AlterEnum: UserAuditAction
ALTER TYPE "UserAuditAction" ADD VALUE 'TRANSFER_SENT';
ALTER TYPE "UserAuditAction" ADD VALUE 'TRANSFER_RECEIVED';
