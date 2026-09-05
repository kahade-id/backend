-- Add KYC_REVOKED to NotificationType enum
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'KYC_REVOKED';
