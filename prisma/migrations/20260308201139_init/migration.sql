-- CreateEnum
DO $$ BEGIN
CREATE TYPE "UserAccountType" AS ENUM ('PERSONAL', 'BUSINESS');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "KycStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'APPROVED', 'REJECTED', 'REVOKED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "OrderStatus" AS ENUM ('WAITING_CONFIRMATION', 'WAITING_PAYMENT', 'PROCESSING', 'IN_DELIVERY', 'COMPLETED', 'DISPUTED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "OrderType" AS ENUM ('PHYSICAL_GOODS', 'DIGITAL_GOODS', 'SERVICE', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "OrderCancelReason" AS ENUM ('TIMEOUT_CONFIRMATION', 'TIMEOUT_PAYMENT', 'TIMEOUT_PROCESSING', 'TIMEOUT_DELIVERY', 'REJECTED_BY_COUNTERPART', 'ADMIN_FORCE_CANCEL', 'USER_MUTUAL_CANCEL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "FeeResponsibility" AS ENUM ('BUYER', 'SELLER', 'SPLIT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "WalletTransactionType" AS ENUM ('TOP_UP', 'WITHDRAW', 'ORDER_LOCK', 'ORDER_RELEASE', 'ORDER_REFUND', 'FEE_DEDUCT', 'REFERRAL_REWARD', 'SUBSCRIPTION_PAYMENT', 'ADMIN_CREDIT', 'ADMIN_DEBIT', 'DISPUTE_RELEASE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "WalletTransactionStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'REVERSED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "PaymentProvider" AS ENUM ('MIDTRANS');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "PaymentMethod" AS ENUM ('VIRTUAL_ACCOUNT_BCA', 'VIRTUAL_ACCOUNT_BNI', 'VIRTUAL_ACCOUNT_BRI', 'VIRTUAL_ACCOUNT_MANDIRI', 'VIRTUAL_ACCOUNT_CIMB', 'VIRTUAL_ACCOUNT_PERMATA', 'VIRTUAL_ACCOUNT_OTHER', 'QRIS', 'GOPAY', 'SHOPEEPAY', 'OVO', 'DANA', 'CREDIT_CARD', 'KAHADE_WALLET');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "WithdrawStatus" AS ENUM ('PENDING_OTP', 'PENDING_PROCESS', 'PROCESSING', 'SUCCESS', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'ASSIGNED', 'UNDER_REVIEW', 'WAITING_RESPONSE', 'RESOLVED', 'ESCALATED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "DisputeInitiator" AS ENUM ('BUYER', 'SELLER', 'BOTH');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "DisputeDecisionType" AS ENUM ('FULL_BUYER', 'FULL_SELLER', 'SPLIT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "MembershipRank" AS ENUM ('BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "OtpType" AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET', 'WITHDRAW_CONFIRMATION', 'TWO_FA_DISABLE', 'ACCOUNT_DELETION', 'LOGIN_NEW_DEVICE', 'SENSITIVE_ACTION');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL', 'WHATSAPP', 'SMS', 'PUSH_NOTIFICATION');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "NotificationType" AS ENUM ('ORDER_NEW', 'ORDER_ACCEPTED', 'ORDER_REJECTED', 'ORDER_CANCELLED_TIMEOUT', 'ORDER_PAYMENT_RECEIVED', 'ORDER_SHIPPED', 'ORDER_DEADLINE_REMINDER', 'ORDER_EXTENSION_REQUESTED', 'ORDER_EXTENSION_APPROVED', 'ORDER_EXTENSION_REJECTED', 'ORDER_COMPLETED', 'ORDER_AUTOCOMPLETED', 'DISPUTE_SUBMITTED', 'DISPUTE_ADMIN_JOINED', 'DISPUTE_DECISION', 'CHAT_NEW_MESSAGE', 'WALLET_TOPUP_SUCCESS', 'WALLET_TOPUP_FAILED', 'WALLET_WITHDRAW_SUCCESS', 'WALLET_WITHDRAW_FAILED', 'WALLET_FUNDS_RELEASED', 'KYC_APPROVED', 'KYC_REJECTED', 'KYC_RESUBMIT_REMINDER', 'SECURITY_NEW_LOGIN', 'SECURITY_PASSWORD_CHANGED', 'SECURITY_ACCOUNT_LOCKED', 'SECURITY_2FA_ENABLED', 'SECURITY_2FA_DISABLED', 'SECURITY_BACKUP_CODE_USED', 'SUBSCRIPTION_ACTIVATED', 'SUBSCRIPTION_EXPIRY_REMINDER', 'SUBSCRIPTION_EXPIRED', 'SUBSCRIPTION_RENEWED', 'REFERRAL_REWARD_RECEIVED', 'RATING_NEW', 'RANK_UPGRADED', 'SYSTEM_MAINTENANCE', 'SYSTEM_ANNOUNCEMENT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "SubscriptionPlan" AS ENUM ('MONTHLY', 'ANNUAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'CANCELLED', 'EXPIRED', 'PENDING', 'SUSPENDED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "AdminRole" AS ENUM ('SUPER_ADMIN', 'DISPUTE_ADMIN', 'KYC_ADMIN', 'FINANCE_ADMIN', 'CUSTOMER_SUPPORT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "ReportCategory" AS ENUM ('FRAUD', 'FAKE_IDENTITY', 'INAPPROPRIATE_CONTENT', 'TNC_VIOLATION', 'MONEY_LAUNDERING', 'SPAM', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "ReportStatus" AS ENUM ('PENDING', 'UNDER_REVIEW', 'RESOLVED_ACTION_TAKEN', 'RESOLVED_NO_ACTION', 'DISMISSED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "BankCode" AS ENUM ('BCA', 'BNI', 'BRI', 'MANDIRI', 'CIMB', 'PERMATA', 'DANAMON', 'OCBC', 'PANIN', 'MEGA', 'BTN', 'BSI', 'MAYBANK', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "ChatMessageType" AS ENUM ('TEXT', 'IMAGE', 'FILE', 'SYSTEM');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "DeadlineExtensionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "VoucherType" AS ENUM ('FEE_DISCOUNT_FLAT', 'FEE_DISCOUNT_PERCENT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "AuditAction" AS ENUM ('USER_CREATED', 'USER_UPDATED', 'USER_SUSPENDED', 'USER_BANNED', 'USER_RESTORED', 'KYC_APPROVED', 'KYC_REJECTED', 'KYC_REVOKED', 'ORDER_CREATED', 'ORDER_STATUS_CHANGED', 'ORDER_FORCE_CANCEL', 'ORDER_FORCE_COMPLETE', 'WALLET_CREDIT', 'WALLET_DEBIT', 'DISPUTE_ASSIGNED', 'DISPUTE_DECIDED', 'ADMIN_LOGIN', 'ADMIN_ACTION', 'SYSTEM_CONFIG_CHANGED', 'VOUCHER_CREATED', 'VOUCHER_DEACTIVATED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "UserAuditAction" AS ENUM ('LOGIN', 'LOGOUT', 'LOGOUT_ALL', 'PASSWORD_CHANGED', 'PASSWORD_RESET', 'TWO_FA_ENABLED', 'TWO_FA_DISABLED', 'EMAIL_VERIFIED', 'PROFILE_UPDATED', 'AVATAR_UPDATED', 'USERNAME_SET', 'ACCOUNT_DELETION_REQUESTED', 'KYC_SUBMITTED', 'ORDER_CREATED', 'ORDER_CONFIRMED', 'ORDER_REJECTED', 'ORDER_PAID', 'ORDER_PROCESSED', 'ORDER_SHIPPING_UPDATED', 'ORDER_COMPLETED', 'ORDER_CANCELLED', 'ORDER_DISPUTE_SUBMITTED', 'ORDER_EXTENSION_REQUESTED', 'ORDER_EXTENSION_RESPONDED', 'TOPUP_INITIATED', 'TOPUP_CANCELLED', 'WITHDRAW_REQUESTED', 'WITHDRAW_CONFIRMED', 'BANK_ACCOUNT_ADDED', 'BANK_ACCOUNT_DELETED', 'BANK_ACCOUNT_PRIMARY_SET', 'USER_BLOCKED', 'USER_UNBLOCKED', 'USER_REPORTED', 'NOTIFICATION_PREF_UPDATED', 'SUBSCRIPTION_STARTED', 'SUBSCRIPTION_CANCELLED', 'SUBSCRIPTION_AUTO_RENEW_TOGGLED', 'REFERRAL_CODE_APPLIED', 'RATING_SUBMITTED', 'DISPUTE_EVIDENCE_ADDED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "ActorType" AS ENUM ('BUYER', 'SELLER', 'ADMIN', 'SYSTEM');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "UserRole" AS ENUM ('BUYER', 'SELLER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "VoucherApplicability" AS ENUM ('ALL', 'BUYER_ONLY', 'SELLER_ONLY', 'NEW_USER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
CREATE TYPE "SystemConfigDataType" AS ENUM ('STRING', 'NUMBER', 'BOOLEAN', 'JSON');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "users" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "username" TEXT,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "bio" VARCHAR(160),
    "avatarUrl" TEXT,
    "accountType" "UserAccountType" NOT NULL DEFAULT 'PERSONAL',
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "emailVerifiedAt" TIMESTAMP(3),
    "kycStatus" "KycStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "kycApprovedAt" TIMESTAMP(3),
    "isKahadePlus" BOOLEAN NOT NULL DEFAULT false,
    "subscriptionExpiresAt" TIMESTAMP(3),
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "lastLoginIp" TEXT,
    "passwordChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isBanned" BOOLEAN NOT NULL DEFAULT false,
    "banReason" TEXT,
    "bannedAt" TIMESTAMP(3),
    "bannedBy" TEXT,
    "isVip" BOOLEAN NOT NULL DEFAULT false,
    "vipGrantedAt" TIMESTAMP(3),
    "vipGrantedBy" TEXT,
    "membershipRank" "MembershipRank" NOT NULL DEFAULT 'BRONZE',
    "rankUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalOrdersCompleted" INTEGER NOT NULL DEFAULT 0,
    "totalOrdersAsBuyer" INTEGER NOT NULL DEFAULT 0,
    "totalOrdersAsSeller" INTEGER NOT NULL DEFAULT 0,
    "totalOrdersCancelled" INTEGER NOT NULL DEFAULT 0,
    "totalOrdersDisputed" INTEGER NOT NULL DEFAULT 0,
    "totalTransactionValue" BIGINT NOT NULL DEFAULT 0,
    "averageRating" DECIMAL(3,2) NOT NULL DEFAULT 0,
    "totalRatingCount" INTEGER NOT NULL DEFAULT 0,
    "memberSince" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "user_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jti" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "deviceInfo" TEXT,
    "ipAddress" TEXT NOT NULL,
    "isRevoked" BOOLEAN NOT NULL DEFAULT false,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "user_devices" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "deviceName" TEXT,
    "deviceType" TEXT,
    "os" TEXT,
    "browser" TEXT,
    "ipAddress" TEXT NOT NULL,
    "isTrusted" BOOLEAN NOT NULL DEFAULT false,
    "trustedAt" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "loginCount" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "two_factor_auth" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "secret" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "enabledAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "backupCodes" TEXT[],
    "usedBackupCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "two_factor_auth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "otp_codes" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "email" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "OtpType" NOT NULL,
    "metadata" JSONB,
    "isUsed" BOOLEAN NOT NULL DEFAULT false,
    "usedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "ipAddress" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "notification_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderInApp" BOOLEAN NOT NULL DEFAULT true,
    "orderEmail" BOOLEAN NOT NULL DEFAULT true,
    "walletInApp" BOOLEAN NOT NULL DEFAULT true,
    "walletEmail" BOOLEAN NOT NULL DEFAULT true,
    "securityInApp" BOOLEAN NOT NULL DEFAULT true,
    "securityEmail" BOOLEAN NOT NULL DEFAULT true,
    "chatInApp" BOOLEAN NOT NULL DEFAULT true,
    "disputeInApp" BOOLEAN NOT NULL DEFAULT true,
    "disputeEmail" BOOLEAN NOT NULL DEFAULT true,
    "rankingInApp" BOOLEAN NOT NULL DEFAULT true,
    "marketingEmail" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "kyc_requests" (
    "id" TEXT NOT NULL,
    "kycId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "KycStatus" NOT NULL DEFAULT 'PENDING',
    "ktpPhotoUrl" TEXT NOT NULL,
    "selfiePhotoUrl" TEXT NOT NULL,
    "ktpNumber" TEXT NOT NULL,
    "ktpNumberHash" TEXT NOT NULL,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "adminNotes" TEXT,
    "submittedIp" TEXT,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kyc_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "bank_accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bankCode" "BankCode" NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "accountNumberHash" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "irisAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "wallets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "availableBalance" BIGINT NOT NULL DEFAULT 0,
    "escrowBalance" BIGINT NOT NULL DEFAULT 0,
    "totalBalance" BIGINT NOT NULL DEFAULT 0,
    "todayTopupAmount" BIGINT NOT NULL DEFAULT 0,
    "todayWithdrawAmount" BIGINT NOT NULL DEFAULT 0,
    "lastLimitResetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastTopupAt" TIMESTAMP(3),
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "lockedAt" TIMESTAMP(3),
    "lockReason" TEXT,
    "lockedBy" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "wallet_transactions" (
    "id" TEXT NOT NULL,
    "txId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "type" "WalletTransactionType" NOT NULL,
    "status" "WalletTransactionStatus" NOT NULL DEFAULT 'PENDING',
    "amount" BIGINT NOT NULL,
    "balanceBefore" BIGINT NOT NULL,
    "balanceAfter" BIGINT NOT NULL,
    "orderId" TEXT,
    "paymentTxId" TEXT,
    "bankAccountId" TEXT,
    "description" TEXT NOT NULL,
    "metadata" JSONB,
    "failureReason" TEXT,
    "reversalTxId" TEXT,
    "withdrawStatus" "WithdrawStatus",
    "irisPayoutId" TEXT,
    "irisRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "payment_transactions" (
    "id" TEXT NOT NULL,
    "midtransOrderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT,
    "provider" "PaymentProvider" NOT NULL DEFAULT 'MIDTRANS',
    "method" "PaymentMethod" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'IDR',
    "midtransToken" TEXT,
    "midtransRedirectUrl" TEXT,
    "vaNumber" TEXT,
    "vaBank" TEXT,
    "qrCodeUrl" TEXT,
    "deepLinkUrl" TEXT,
    "webhookReceivedAt" TIMESTAMP(3),
    "webhookPayload" JSONB,
    "fraudStatus" TEXT,
    "expiredAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "orders" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "title" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "orderType" "OrderType" NOT NULL,
    "orderValue" BIGINT NOT NULL,
    "feeAmount" BIGINT NOT NULL,
    "feeResponsibility" "FeeResponsibility" NOT NULL,
    "buyerFeeAmount" BIGINT NOT NULL,
    "sellerFeeAmount" BIGINT NOT NULL,
    "buyerPayAmount" BIGINT NOT NULL,
    "sellerReceiveAmount" BIGINT NOT NULL,
    "voucherId" TEXT,
    "voucherDiscount" BIGINT NOT NULL DEFAULT 0,
    "isKahadePlus" BOOLEAN NOT NULL DEFAULT false,
    "feeRate" DECIMAL(5,4) NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'WAITING_CONFIRMATION',
    "cancelReason" "OrderCancelReason",
    "cancelNote" TEXT,
    "deliveryDeadlineDays" INTEGER NOT NULL,
    "deliveryDeadlineAt" TIMESTAMP(3),
    "paymentDeadlineAt" TIMESTAMP(3),
    "confirmationDeadlineAt" TIMESTAMP(3),
    "processingDeadlineAt" TIMESTAMP(3),
    "trackingNumber" TEXT,
    "courierName" TEXT,
    "trackingNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "shippedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "disputedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdByBuyer" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "order_status_histories" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fromStatus" "OrderStatus",
    "toStatus" "OrderStatus" NOT NULL,
    "changedBy" TEXT,
    "changedByType" "ActorType",
    "reason" TEXT,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "order_extension_requests" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "requestedByRole" "UserRole" NOT NULL,
    "extensionDays" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "DeadlineExtensionStatus" NOT NULL DEFAULT 'PENDING',
    "respondedBy" TEXT,
    "respondedAt" TIMESTAMP(3),
    "rejectionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_extension_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "chat_rooms" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "archivedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "chat_messages" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "senderId" TEXT,
    "messageType" "ChatMessageType" NOT NULL DEFAULT 'TEXT',
    "content" TEXT,
    "isEdited" BOOLEAN NOT NULL DEFAULT false,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "readAt" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "chat_attachments" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "thumbnailUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "disputes" (
    "id" TEXT NOT NULL,
    "disputeId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "initiatedBy" "DisputeInitiator" NOT NULL,
    "initiatorUserId" TEXT NOT NULL,
    "buyerClaim" TEXT,
    "sellerClaim" TEXT,
    "buyerClaimedAt" TIMESTAMP(3),
    "sellerClaimedAt" TIMESTAMP(3),
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "assignedAdminId" TEXT,
    "assignedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "slaHours" INTEGER,
    "slaDeadlineAt" TIMESTAMP(3),
    "isSlaBreached" BOOLEAN NOT NULL DEFAULT false,
    "adminNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "dispute_evidences" (
    "id" TEXT NOT NULL,
    "disputeId" TEXT NOT NULL,
    "submittedByRole" "ActorType" NOT NULL,
    "submittedByUserId" TEXT,
    "submittedByAdminId" TEXT,
    "description" TEXT NOT NULL,
    "fileUrls" TEXT[],
    "fileTypes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispute_evidences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "dispute_decisions" (
    "id" TEXT NOT NULL,
    "disputeId" TEXT NOT NULL,
    "decidedBy" TEXT NOT NULL,
    "decisionType" "DisputeDecisionType" NOT NULL,
    "buyerAmount" BIGINT NOT NULL,
    "sellerAmount" BIGINT NOT NULL,
    "buyerPercent" DECIMAL(5,2),
    "sellerPercent" DECIMAL(5,2),
    "decisionNotes" TEXT NOT NULL,
    "isExecuted" BOOLEAN NOT NULL DEFAULT false,
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dispute_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ratings" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "giverId" TEXT NOT NULL,
    "receiverId" TEXT NOT NULL,
    "stars" INTEGER NOT NULL,
    "comment" VARCHAR(500),
    "giverRole" "UserRole" NOT NULL,
    "isHidden" BOOLEAN NOT NULL DEFAULT false,
    "hiddenAt" TIMESTAMP(3),
    "hiddenBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "notifications" (
    "id" TEXT NOT NULL,
    "notifId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "channel" "NotificationChannel" NOT NULL DEFAULT 'IN_APP',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "actionUrl" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "isSent" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failReason" TEXT,
    "refType" TEXT,
    "refId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "vouchers" (
    "id" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "voucherType" "VoucherType" NOT NULL,
    "discountAmount" BIGINT,
    "discountPercent" DECIMAL(5,2),
    "maxDiscountAmount" BIGINT,
    "maxUsageTotal" INTEGER,
    "maxUsagePerUser" INTEGER NOT NULL DEFAULT 1,
    "currentUsage" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "minOrderValue" BIGINT,
    "applicableTo" "VoucherApplicability" NOT NULL DEFAULT 'ALL',
    "createdBy" TEXT NOT NULL,
    "deactivatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deactivatedAt" TIMESTAMP(3),

    CONSTRAINT "vouchers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "voucher_usages" (
    "id" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "discountApplied" BIGINT NOT NULL,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voucher_usages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "referral_codes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "totalReferrals" INTEGER NOT NULL DEFAULT 0,
    "totalRewardEarned" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "referral_relations" (
    "id" TEXT NOT NULL,
    "referralCodeId" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "refereeId" TEXT NOT NULL,
    "isReferrerKyc" BOOLEAN NOT NULL DEFAULT false,
    "isRefereeKyc" BOOLEAN NOT NULL DEFAULT false,
    "isRewardActive" BOOLEAN NOT NULL DEFAULT false,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rewardActivatedAt" TIMESTAMP(3),

    CONSTRAINT "referral_relations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "referral_rewards" (
    "id" TEXT NOT NULL,
    "relationId" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "triggeredByOrderId" TEXT NOT NULL,
    "feeAmount" BIGINT NOT NULL,
    "rewardAmount" BIGINT NOT NULL,
    "isCredited" BOOLEAN NOT NULL DEFAULT false,
    "creditedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_rewards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "plan" "SubscriptionPlan" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'PENDING',
    "price" BIGINT NOT NULL,
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "isAutoRenew" BOOLEAN NOT NULL DEFAULT false,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "paymentMethod" "PaymentMethod",
    "paymentTxId" TEXT,
    "lastPaymentAt" TIMESTAMP(3),
    "nextPaymentAt" TIMESTAMP(3),
    "paymentFailedAt" TIMESTAMP(3),
    "feeSavingsUsed" BIGINT NOT NULL DEFAULT 0,
    "feeSavingsLimit" BIGINT NOT NULL DEFAULT 500000000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "membership_rank_histories" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fromRank" "MembershipRank",
    "toRank" "MembershipRank" NOT NULL,
    "reason" TEXT,
    "totalOrders" INTEGER NOT NULL,
    "totalValue" BIGINT NOT NULL,
    "averageRating" DECIMAL(3,2) NOT NULL,
    "memberDays" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_rank_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "block_lists" (
    "id" TEXT NOT NULL,
    "blockerId" TEXT NOT NULL,
    "blockedId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "block_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "user_reports" (
    "id" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "category" "ReportCategory" NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "evidenceUrls" TEXT[],
    "relatedOrderId" TEXT,
    "relatedMessageId" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "badges" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "iconUrl" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "badges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "user_badges" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "badgeId" TEXT NOT NULL,
    "earnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_badges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "password_histories" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "admin_users" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "lastLoginIp" TEXT,
    "mfaSecret" TEXT,
    "isMfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "admin_audit_logs" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "description" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ipAddress" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "system_configs" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "description" TEXT,
    "dataType" "SystemConfigDataType" NOT NULL DEFAULT 'STRING',
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "webhook_logs" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "headers" JSONB,
    "isProcessed" BOOLEAN NOT NULL DEFAULT false,
    "processedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" "UserAuditAction" NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "users_userId_key" ON "users"("userId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "users_kycStatus_idx" ON "users"("kycStatus");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "users_membershipRank_idx" ON "users"("membershipRank");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "users_createdAt_idx" ON "users"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "users_isActive_isBanned_idx" ON "users"("isActive", "isBanned");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "users_deletedAt_idx" ON "users"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "user_sessions_jti_key" ON "user_sessions"("jti");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "user_sessions_refreshToken_key" ON "user_sessions"("refreshToken");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_sessions_userId_idx" ON "user_sessions"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_sessions_userId_isRevoked_idx" ON "user_sessions"("userId", "isRevoked");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_sessions_expiresAt_idx" ON "user_sessions"("expiresAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_devices_userId_idx" ON "user_devices"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_devices_deviceId_idx" ON "user_devices"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "user_devices_userId_deviceId_key" ON "user_devices"("userId", "deviceId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "two_factor_auth_userId_key" ON "two_factor_auth"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "otp_codes_email_type_idx" ON "otp_codes"("email", "type");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "otp_codes_userId_idx" ON "otp_codes"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "otp_codes_expiresAt_idx" ON "otp_codes"("expiresAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "otp_codes_userId_type_isUsed_idx" ON "otp_codes"("userId", "type", "isUsed");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "notification_preferences_userId_key" ON "notification_preferences"("userId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "kyc_requests_kycId_key" ON "kyc_requests"("kycId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "kyc_requests_ktpNumberHash_key" ON "kyc_requests"("ktpNumberHash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "kyc_requests_userId_idx" ON "kyc_requests"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "kyc_requests_status_idx" ON "kyc_requests"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "kyc_requests_status_createdAt_idx" ON "kyc_requests"("status", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "kyc_requests_reviewedBy_idx" ON "kyc_requests"("reviewedBy");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "bank_accounts_accountNumberHash_key" ON "bank_accounts"("accountNumberHash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "bank_accounts_userId_idx" ON "bank_accounts"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "bank_accounts_irisAccountId_idx" ON "bank_accounts"("irisAccountId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "bank_accounts_userId_deletedAt_idx" ON "bank_accounts"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "bank_accounts_deletedAt_idx" ON "bank_accounts"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "wallets_userId_key" ON "wallets"("userId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_transactions_txId_key" ON "wallet_transactions"("txId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "wallet_transactions_walletId_idx" ON "wallet_transactions"("walletId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "wallet_transactions_orderId_idx" ON "wallet_transactions"("orderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "wallet_transactions_type_status_idx" ON "wallet_transactions"("type", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "wallet_transactions_createdAt_idx" ON "wallet_transactions"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "wallet_transactions_walletId_createdAt_idx" ON "wallet_transactions"("walletId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "wallet_transactions_walletId_type_status_idx" ON "wallet_transactions"("walletId", "type", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "wallet_transactions_withdrawStatus_idx" ON "wallet_transactions"("withdrawStatus");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "wallet_transactions_bankAccountId_idx" ON "wallet_transactions"("bankAccountId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "wallet_transactions_paymentTxId_idx" ON "wallet_transactions"("paymentTxId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "wallet_transactions_reversalTxId_idx" ON "wallet_transactions"("reversalTxId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "wallet_transactions_irisPayoutId_idx" ON "wallet_transactions"("irisPayoutId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "payment_transactions_midtransOrderId_key" ON "payment_transactions"("midtransOrderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "payment_transactions_userId_idx" ON "payment_transactions"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "payment_transactions_orderId_idx" ON "payment_transactions"("orderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "payment_transactions_status_idx" ON "payment_transactions"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "payment_transactions_createdAt_idx" ON "payment_transactions"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "orders_orderId_key" ON "orders"("orderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "orders_buyerId_idx" ON "orders"("buyerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "orders_sellerId_idx" ON "orders"("sellerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "orders_status_createdAt_idx" ON "orders"("status", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "orders_createdAt_idx" ON "orders"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "orders_buyerId_status_idx" ON "orders"("buyerId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "orders_sellerId_status_idx" ON "orders"("sellerId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "orders_buyerId_createdAt_idx" ON "orders"("buyerId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "orders_sellerId_createdAt_idx" ON "orders"("sellerId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "orders_voucherId_idx" ON "orders"("voucherId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "orders_trackingNumber_idx" ON "orders"("trackingNumber");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "order_status_histories_orderId_idx" ON "order_status_histories"("orderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "order_status_histories_createdAt_idx" ON "order_status_histories"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "order_extension_requests_orderId_idx" ON "order_extension_requests"("orderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "order_extension_requests_orderId_status_idx" ON "order_extension_requests"("orderId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "order_extension_requests_requestedBy_idx" ON "order_extension_requests"("requestedBy");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "order_extension_requests_respondedBy_idx" ON "order_extension_requests"("respondedBy");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "chat_rooms_orderId_key" ON "chat_rooms"("orderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "chat_messages_roomId_idx" ON "chat_messages"("roomId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "chat_messages_roomId_createdAt_idx" ON "chat_messages"("roomId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "chat_messages_senderId_idx" ON "chat_messages"("senderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "chat_messages_createdAt_idx" ON "chat_messages"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "chat_attachments_messageId_idx" ON "chat_attachments"("messageId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "chat_attachments_createdAt_idx" ON "chat_attachments"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "disputes_disputeId_key" ON "disputes"("disputeId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "disputes_orderId_key" ON "disputes"("orderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "disputes_status_idx" ON "disputes"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "disputes_status_createdAt_idx" ON "disputes"("status", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "disputes_assignedAdminId_idx" ON "disputes"("assignedAdminId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "disputes_createdAt_idx" ON "disputes"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "disputes_initiatorUserId_idx" ON "disputes"("initiatorUserId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "dispute_evidences_disputeId_idx" ON "dispute_evidences"("disputeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "dispute_evidences_createdAt_idx" ON "dispute_evidences"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "dispute_evidences_submittedByUserId_idx" ON "dispute_evidences"("submittedByUserId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "dispute_evidences_submittedByAdminId_idx" ON "dispute_evidences"("submittedByAdminId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "dispute_decisions_disputeId_key" ON "dispute_decisions"("disputeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "dispute_decisions_decidedBy_idx" ON "dispute_decisions"("decidedBy");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "dispute_decisions_createdAt_idx" ON "dispute_decisions"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ratings_receiverId_idx" ON "ratings"("receiverId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ratings_receiverId_isHidden_createdAt_idx" ON "ratings"("receiverId", "isHidden", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ratings_giverId_idx" ON "ratings"("giverId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ratings_orderId_idx" ON "ratings"("orderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ratings_createdAt_idx" ON "ratings"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ratings_orderId_giverId_key" ON "ratings"("orderId", "giverId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_notifId_key" ON "notifications"("notifId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "notifications_userId_isRead_idx" ON "notifications"("userId", "isRead");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "notifications_userId_createdAt_idx" ON "notifications"("userId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "notifications_userId_isRead_createdAt_idx" ON "notifications"("userId", "isRead", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "notifications_refId_refType_idx" ON "notifications"("refId", "refType");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "notifications_expiresAt_idx" ON "notifications"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "vouchers_voucherId_key" ON "vouchers"("voucherId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "vouchers_code_key" ON "vouchers"("code");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "vouchers_isActive_validUntil_idx" ON "vouchers"("isActive", "validUntil");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "vouchers_isActive_validFrom_validUntil_idx" ON "vouchers"("isActive", "validFrom", "validUntil");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "vouchers_isActive_idx" ON "vouchers"("isActive");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "vouchers_createdBy_idx" ON "vouchers"("createdBy");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "voucher_usages_voucherId_idx" ON "voucher_usages"("voucherId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "voucher_usages_userId_idx" ON "voucher_usages"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "voucher_usages_orderId_idx" ON "voucher_usages"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "voucher_usages_voucherId_userId_orderId_key" ON "voucher_usages"("voucherId", "userId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "referral_codes_userId_key" ON "referral_codes"("userId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "referral_codes_code_key" ON "referral_codes"("code");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "referral_relations_refereeId_key" ON "referral_relations"("refereeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "referral_relations_referralCodeId_idx" ON "referral_relations"("referralCodeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "referral_relations_referrerId_idx" ON "referral_relations"("referrerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "referral_rewards_relationId_idx" ON "referral_rewards"("relationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "referral_rewards_referrerId_idx" ON "referral_rewards"("referrerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "referral_rewards_referrerId_isCredited_idx" ON "referral_rewards"("referrerId", "isCredited");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "referral_rewards_triggeredByOrderId_idx" ON "referral_rewards"("triggeredByOrderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "subscriptions_userId_idx" ON "subscriptions"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "subscriptions_status_idx" ON "subscriptions"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "subscriptions_userId_status_idx" ON "subscriptions"("userId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "subscriptions_paymentTxId_idx" ON "subscriptions"("paymentTxId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "subscriptions_nextPaymentAt_idx" ON "subscriptions"("nextPaymentAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "subscriptions_status_isAutoRenew_nextPaymentAt_idx" ON "subscriptions"("status", "isAutoRenew", "nextPaymentAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "membership_rank_histories_userId_idx" ON "membership_rank_histories"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "membership_rank_histories_createdAt_idx" ON "membership_rank_histories"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "block_lists_blockerId_idx" ON "block_lists"("blockerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "block_lists_blockedId_idx" ON "block_lists"("blockedId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "block_lists_blockerId_blockedId_key" ON "block_lists"("blockerId", "blockedId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_reports_reporterId_idx" ON "user_reports"("reporterId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_reports_targetId_idx" ON "user_reports"("targetId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_reports_status_idx" ON "user_reports"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_reports_status_createdAt_idx" ON "user_reports"("status", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_reports_createdAt_idx" ON "user_reports"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_reports_relatedOrderId_idx" ON "user_reports"("relatedOrderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_reports_reviewedBy_idx" ON "user_reports"("reviewedBy");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "badges_name_key" ON "badges"("name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_badges_userId_idx" ON "user_badges"("userId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "user_badges_userId_badgeId_key" ON "user_badges"("userId", "badgeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "password_histories_userId_idx" ON "password_histories"("userId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "admin_users_adminId_key" ON "admin_users"("adminId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "admin_users_email_key" ON "admin_users"("email");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "admin_users_isActive_idx" ON "admin_users"("isActive");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "admin_users_deletedAt_idx" ON "admin_users"("deletedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "admin_users_createdBy_idx" ON "admin_users"("createdBy");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "admin_audit_logs_adminId_idx" ON "admin_audit_logs"("adminId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "admin_audit_logs_targetId_targetType_idx" ON "admin_audit_logs"("targetId", "targetType");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "admin_audit_logs_createdAt_idx" ON "admin_audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "admin_audit_logs_action_idx" ON "admin_audit_logs"("action");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "system_configs_key_key" ON "system_configs"("key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "webhook_logs_source_isProcessed_idx" ON "webhook_logs"("source", "isProcessed");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "webhook_logs_source_event_idx" ON "webhook_logs"("source", "event");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "webhook_logs_createdAt_idx" ON "webhook_logs"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "audit_logs_userId_idx" ON "audit_logs"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "audit_logs_entityId_entityType_idx" ON "audit_logs"("entityId", "entityType");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "audit_logs_requestId_idx" ON "audit_logs"("requestId");

-- AddForeignKey
ALTER TABLE "user_sessions" DROP CONSTRAINT IF EXISTS "user_sessions_userId_fkey";
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_devices" DROP CONSTRAINT IF EXISTS "user_devices_userId_fkey";
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "two_factor_auth" DROP CONSTRAINT IF EXISTS "two_factor_auth_userId_fkey";
ALTER TABLE "two_factor_auth" ADD CONSTRAINT "two_factor_auth_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otp_codes" DROP CONSTRAINT IF EXISTS "otp_codes_userId_fkey";
ALTER TABLE "otp_codes" ADD CONSTRAINT "otp_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" DROP CONSTRAINT IF EXISTS "notification_preferences_userId_fkey";
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_requests" DROP CONSTRAINT IF EXISTS "kyc_requests_userId_fkey";
ALTER TABLE "kyc_requests" ADD CONSTRAINT "kyc_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_requests" DROP CONSTRAINT IF EXISTS "kyc_requests_reviewedBy_fkey";
ALTER TABLE "kyc_requests" ADD CONSTRAINT "kyc_requests_reviewedBy_fkey" FOREIGN KEY ("reviewedBy") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_accounts" DROP CONSTRAINT IF EXISTS "bank_accounts_userId_fkey";
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallets" DROP CONSTRAINT IF EXISTS "wallets_userId_fkey";
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" DROP CONSTRAINT IF EXISTS "wallet_transactions_walletId_fkey";
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" DROP CONSTRAINT IF EXISTS "wallet_transactions_orderId_fkey";
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" DROP CONSTRAINT IF EXISTS "wallet_transactions_paymentTxId_fkey";
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_paymentTxId_fkey" FOREIGN KEY ("paymentTxId") REFERENCES "payment_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" DROP CONSTRAINT IF EXISTS "wallet_transactions_bankAccountId_fkey";
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" DROP CONSTRAINT IF EXISTS "wallet_transactions_reversalTxId_fkey";
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_reversalTxId_fkey" FOREIGN KEY ("reversalTxId") REFERENCES "wallet_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" DROP CONSTRAINT IF EXISTS "payment_transactions_userId_fkey";
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" DROP CONSTRAINT IF EXISTS "payment_transactions_orderId_fkey";
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_buyerId_fkey";
ALTER TABLE "orders" ADD CONSTRAINT "orders_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_sellerId_fkey";
ALTER TABLE "orders" ADD CONSTRAINT "orders_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_voucherId_fkey";
ALTER TABLE "orders" ADD CONSTRAINT "orders_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_histories" DROP CONSTRAINT IF EXISTS "order_status_histories_orderId_fkey";
ALTER TABLE "order_status_histories" ADD CONSTRAINT "order_status_histories_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_extension_requests" DROP CONSTRAINT IF EXISTS "order_extension_requests_orderId_fkey";
ALTER TABLE "order_extension_requests" ADD CONSTRAINT "order_extension_requests_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_extension_requests" DROP CONSTRAINT IF EXISTS "order_extension_requests_requestedBy_fkey";
ALTER TABLE "order_extension_requests" ADD CONSTRAINT "order_extension_requests_requestedBy_fkey" FOREIGN KEY ("requestedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_extension_requests" DROP CONSTRAINT IF EXISTS "order_extension_requests_respondedBy_fkey";
ALTER TABLE "order_extension_requests" ADD CONSTRAINT "order_extension_requests_respondedBy_fkey" FOREIGN KEY ("respondedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_rooms" DROP CONSTRAINT IF EXISTS "chat_rooms_orderId_fkey";
ALTER TABLE "chat_rooms" ADD CONSTRAINT "chat_rooms_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" DROP CONSTRAINT IF EXISTS "chat_messages_roomId_fkey";
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "chat_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" DROP CONSTRAINT IF EXISTS "chat_messages_senderId_fkey";
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_attachments" DROP CONSTRAINT IF EXISTS "chat_attachments_messageId_fkey";
ALTER TABLE "chat_attachments" ADD CONSTRAINT "chat_attachments_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "chat_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" DROP CONSTRAINT IF EXISTS "disputes_orderId_fkey";
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" DROP CONSTRAINT IF EXISTS "disputes_initiatorUserId_fkey";
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_initiatorUserId_fkey" FOREIGN KEY ("initiatorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" DROP CONSTRAINT IF EXISTS "disputes_assignedAdminId_fkey";
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_assignedAdminId_fkey" FOREIGN KEY ("assignedAdminId") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_evidences" DROP CONSTRAINT IF EXISTS "dispute_evidences_disputeId_fkey";
ALTER TABLE "dispute_evidences" ADD CONSTRAINT "dispute_evidences_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "disputes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_evidences" DROP CONSTRAINT IF EXISTS "dispute_evidences_submittedByUserId_fkey";
ALTER TABLE "dispute_evidences" ADD CONSTRAINT "dispute_evidences_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_evidences" DROP CONSTRAINT IF EXISTS "dispute_evidences_submittedByAdminId_fkey";
ALTER TABLE "dispute_evidences" ADD CONSTRAINT "dispute_evidences_submittedByAdminId_fkey" FOREIGN KEY ("submittedByAdminId") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_decisions" DROP CONSTRAINT IF EXISTS "dispute_decisions_disputeId_fkey";
ALTER TABLE "dispute_decisions" ADD CONSTRAINT "dispute_decisions_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "disputes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_decisions" DROP CONSTRAINT IF EXISTS "dispute_decisions_decidedBy_fkey";
ALTER TABLE "dispute_decisions" ADD CONSTRAINT "dispute_decisions_decidedBy_fkey" FOREIGN KEY ("decidedBy") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ratings" DROP CONSTRAINT IF EXISTS "ratings_orderId_fkey";
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ratings" DROP CONSTRAINT IF EXISTS "ratings_giverId_fkey";
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_giverId_fkey" FOREIGN KEY ("giverId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ratings" DROP CONSTRAINT IF EXISTS "ratings_receiverId_fkey";
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_userId_fkey";
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voucher_usages" DROP CONSTRAINT IF EXISTS "voucher_usages_voucherId_fkey";
ALTER TABLE "voucher_usages" ADD CONSTRAINT "voucher_usages_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "vouchers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voucher_usages" DROP CONSTRAINT IF EXISTS "voucher_usages_userId_fkey";
ALTER TABLE "voucher_usages" ADD CONSTRAINT "voucher_usages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voucher_usages" DROP CONSTRAINT IF EXISTS "voucher_usages_orderId_fkey";
ALTER TABLE "voucher_usages" ADD CONSTRAINT "voucher_usages_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_codes" DROP CONSTRAINT IF EXISTS "referral_codes_userId_fkey";
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_relations" DROP CONSTRAINT IF EXISTS "referral_relations_referralCodeId_fkey";
ALTER TABLE "referral_relations" ADD CONSTRAINT "referral_relations_referralCodeId_fkey" FOREIGN KEY ("referralCodeId") REFERENCES "referral_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_relations" DROP CONSTRAINT IF EXISTS "referral_relations_referrerId_fkey";
ALTER TABLE "referral_relations" ADD CONSTRAINT "referral_relations_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_relations" DROP CONSTRAINT IF EXISTS "referral_relations_refereeId_fkey";
ALTER TABLE "referral_relations" ADD CONSTRAINT "referral_relations_refereeId_fkey" FOREIGN KEY ("refereeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_rewards" DROP CONSTRAINT IF EXISTS "referral_rewards_relationId_fkey";
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_relationId_fkey" FOREIGN KEY ("relationId") REFERENCES "referral_relations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_rewards" DROP CONSTRAINT IF EXISTS "referral_rewards_referrerId_fkey";
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_rewards" DROP CONSTRAINT IF EXISTS "referral_rewards_triggeredByOrderId_fkey";
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_triggeredByOrderId_fkey" FOREIGN KEY ("triggeredByOrderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" DROP CONSTRAINT IF EXISTS "subscriptions_userId_fkey";
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" DROP CONSTRAINT IF EXISTS "subscriptions_paymentTxId_fkey";
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_paymentTxId_fkey" FOREIGN KEY ("paymentTxId") REFERENCES "payment_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_rank_histories" DROP CONSTRAINT IF EXISTS "membership_rank_histories_userId_fkey";
ALTER TABLE "membership_rank_histories" ADD CONSTRAINT "membership_rank_histories_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "block_lists" DROP CONSTRAINT IF EXISTS "block_lists_blockerId_fkey";
ALTER TABLE "block_lists" ADD CONSTRAINT "block_lists_blockerId_fkey" FOREIGN KEY ("blockerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "block_lists" DROP CONSTRAINT IF EXISTS "block_lists_blockedId_fkey";
ALTER TABLE "block_lists" ADD CONSTRAINT "block_lists_blockedId_fkey" FOREIGN KEY ("blockedId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_reports" DROP CONSTRAINT IF EXISTS "user_reports_reporterId_fkey";
ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_reports" DROP CONSTRAINT IF EXISTS "user_reports_targetId_fkey";
ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_badges" DROP CONSTRAINT IF EXISTS "user_badges_userId_fkey";
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_badges" DROP CONSTRAINT IF EXISTS "user_badges_badgeId_fkey";
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_badgeId_fkey" FOREIGN KEY ("badgeId") REFERENCES "badges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_histories" DROP CONSTRAINT IF EXISTS "password_histories_userId_fkey";
ALTER TABLE "password_histories" ADD CONSTRAINT "password_histories_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_audit_logs" DROP CONSTRAINT IF EXISTS "admin_audit_logs_adminId_fkey";
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "audit_logs_userId_fkey";
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
