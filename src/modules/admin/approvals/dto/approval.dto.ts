import { IsIn, IsInt, IsObject, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AdminRole } from '@prisma/client';

/**
 * Tipe aksi yang didukung dual control (maker-checker).
 * Executor untuk tiap tipe didaftarkan di ApprovalsService.
 */
export const APPROVAL_ACTION_TYPES = [
  'DISPUTE_RESOLVE',
  'INSURANCE_CLAIM_PAY',
  'WALLET_ADJUST',
  'COMMERCE_REFUND',
  'DISBURSEMENT_REOPEN',
  'OPS_SETTING_CHANGE',
  // SYS-B-401/402/405 (audit 2026-10-03 ronde 3): retrofit dual control untuk
  // aksi uang admin yang terlewat.
  'DISBURSEMENT_FORCE_SUCCESS',
  'VOUCHER_CREATE',
  'CAMPAIGN_ACTIVATE',
  'MONEY_VALUE_GRANT',
  'SYSTEM_CONFIG_CHANGE',
] as const;

export type ApprovalActionType = (typeof APPROVAL_ACTION_TYPES)[number];

/**
 * Role yang boleh mengusulkan/menyetujui tiap tipe aksi.
 * Dievaluasi di propose DAN approve (fail-closed).
 */
export const APPROVAL_ACTION_ROLES: Record<ApprovalActionType, AdminRole[]> = {
  DISPUTE_RESOLVE: [AdminRole.SUPER_ADMIN, AdminRole.DISPUTE_ADMIN],
  INSURANCE_CLAIM_PAY: [AdminRole.SUPER_ADMIN, AdminRole.FINANCE_ADMIN],
  WALLET_ADJUST: [AdminRole.SUPER_ADMIN],
  COMMERCE_REFUND: [AdminRole.SUPER_ADMIN, AdminRole.FINANCE_ADMIN],
  DISBURSEMENT_REOPEN: [AdminRole.SUPER_ADMIN],
  OPS_SETTING_CHANGE: [AdminRole.SUPER_ADMIN],
  // SYS-B-401/402/405: role mengikuti guard @AdminRoles endpoint domain-nya.
  DISBURSEMENT_FORCE_SUCCESS: [AdminRole.SUPER_ADMIN],
  VOUCHER_CREATE: [AdminRole.SUPER_ADMIN, AdminRole.FINANCE_ADMIN],
  CAMPAIGN_ACTIVATE: [AdminRole.SUPER_ADMIN],
  MONEY_VALUE_GRANT: [AdminRole.SUPER_ADMIN, AdminRole.FINANCE_ADMIN],
  SYSTEM_CONFIG_CHANGE: [AdminRole.SUPER_ADMIN],
};

export class ProposeApprovalDto {
  @ApiProperty({ enum: APPROVAL_ACTION_TYPES, description: 'Jenis aksi yang butuh persetujuan kedua' })
  @IsIn(APPROVAL_ACTION_TYPES as unknown as string[])
  actionType!: ApprovalActionType;

  @ApiPropertyOptional({ description: 'ID target aksi (disputeId/orderId/claimId/…)', maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  targetId?: string;

  @ApiProperty({ description: 'Payload aksi — divalidasi per actionType lalu diteruskan ke executor saat approve' })
  @IsObject()
  payload!: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Nominal aksi dalam SEN (untuk ambang & audit)', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  amountSen?: number;

  @ApiProperty({ description: 'Kunci idempotensi — propose ulang dengan key sama mengembalikan record yang ada', minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  idempotencyKey!: string;
}

export class RejectApprovalDto {
  @ApiPropertyOptional({ description: 'Alasan penolakan (audit trail)', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
