-- Add KYC_DOCUMENTS_ACCESSED to AuditAction enum
-- [ISSUE-041 FIX] admin-kyc.service.ts uses this action to log KYC document access events.
-- Adding the value to the enum both fixes the TypeScript compilation error and
-- makes the audit trail queryable by action type.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KYC_DOCUMENTS_ACCESSED';
