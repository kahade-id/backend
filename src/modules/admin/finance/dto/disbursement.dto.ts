import { IsOptional, IsEnum, IsString, MaxLength, MinLength, IsIn } from 'class-validator';
import { EscrowDisbursementScope, EscrowDisbursementStatus } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../../common/dto/pagination.dto';

/**
 * BAI-043 (P0): filter antrean admin lifecycle EscrowDisbursement DANA.
 * Read-only — tidak ada aksi uang di fase ini.
 */
export class DisbursementQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    enum: EscrowDisbursementStatus,
    description: 'Filter status: PENDING | HELD_NO_BANK | PROCESSING | SUCCESS | FAILED | CANCELLED | NEEDS_REVIEW',
  })
  @IsOptional()
  @IsEnum(EscrowDisbursementStatus)
  status?: EscrowDisbursementStatus;

  @ApiPropertyOptional({
    enum: EscrowDisbursementScope,
    description: 'Filter scope: ORDER_ESCROW | MILESTONE | LEGACY_WALLET_PAYOUT | CASHBACK | REFERRAL | DISPUTE_RELEASE',
  })
  @IsOptional()
  @IsEnum(EscrowDisbursementScope)
  scope?: EscrowDisbursementScope;

  @ApiPropertyOptional({
    description: 'Pencarian: idempotencyKey, danaReferenceNo, danaPartnerReferenceNo, atau orderId publik (maks 100 karakter)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export const DISBURSEMENT_REVIEW_DECISIONS = ['RETRY', 'CANCEL', 'FORCE_SUCCESS'] as const;
export type DisbursementReviewDecision = (typeof DISBURSEMENT_REVIEW_DECISIONS)[number];

/**
 * BAI-044 (P1): keputusan review manual untuk baris NEEDS_REVIEW.
 * - RETRY → status kembali PENDING agar cron retryDue memproses ulang
 *   (idempoten via partnerReferenceNo DANA yang stabil).
 * - CANCEL → CANCELLED (terminal).
 * - FORCE_SUCCESS → SUCCESS manual; HANYA bila ada bukti transfer nyata
 *   (dicatat di `reason`, min 10 karakter — fail-closed bila ragu).
 */
export class DisbursementReviewDto {
  @ApiProperty({
    enum: DISBURSEMENT_REVIEW_DECISIONS,
    description: 'RETRY = antre ulang ke cron; CANCEL = batalkan; FORCE_SUCCESS = tandai sukses manual (butuh bukti transfer di reason)',
  })
  @IsIn(DISBURSEMENT_REVIEW_DECISIONS)
  decision!: DisbursementReviewDecision;

  @ApiProperty({
    description: 'Alasan keputusan (min 10 karakter). Untuk FORCE_SUCCESS wajib memuat bukti transfer (mis. referensi DANA dashboard).',
    minLength: 10,
    maxLength: 1000,
  })
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  reason!: string;
}
