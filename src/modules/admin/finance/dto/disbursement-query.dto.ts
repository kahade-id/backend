import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsIn, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../../../common/dto/pagination.dto';
import { EscrowDisbursementStatus } from '@prisma/client';

/**
 * MFE-015: query antrean disbursement escrow untuk admin.
 * Filter `status` menarget kasus operasional: HELD_NO_BANK (seller belum
 * punya rekening terverifikasi — fail-closed) dan NEEDS_REVIEW (status DANA
 * tak dikenal yang sengaja tidak di-auto-FAILED — butuh review manual).
 */
export class DisbursementListQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    enum: EscrowDisbursementStatus,
    description: 'Filter status disbursement (mis. HELD_NO_BANK, NEEDS_REVIEW)',
  })
  @IsOptional()
  @IsEnum(EscrowDisbursementStatus)
  status?: EscrowDisbursementStatus;

  @ApiPropertyOptional({
    description: 'Filter scope: ORDER_ESCROW | MILESTONE | DISPUTE_RELEASE | CASHBACK | REFERRAL | LEGACY_PAYOUT',
  })
  @IsOptional()
  @IsString()
  scope?: string;

  @ApiPropertyOptional({ description: 'Cari: orderId publik / userId seller / danaPartnerReferenceNo' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ description: 'Urut: createdAt | updatedAt | amountSen', enum: ['createdAt', 'updatedAt', 'amountSen'] })
  @IsOptional()
  @IsIn(['createdAt', 'updatedAt', 'amountSen'])
  sortBy?: 'createdAt' | 'updatedAt' | 'amountSen';

  @ApiPropertyOptional({ enum: ['asc', 'desc'] })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';
}
