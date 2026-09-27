import { IsEnum, IsInt, Min, Max, ValidateIf } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * ADM-109 — query untuk GET /v1/admin/disputes/:id/resolve/preview.
 * Mirip DisputeDecisionDto tapi tanpa decisionNotes (preview tidak mencatat
 * putusan). Validasi persen SPLIT sama dengan resolve agar angka pratinjau
 * pasti bisa dieksekusi.
 */
export class ResolvePreviewQueryDto {
  @ApiProperty({ enum: ['FULL_BUYER', 'FULL_SELLER', 'SPLIT'], description: 'Proposed dispute decision' })
  @IsEnum(['FULL_BUYER', 'FULL_SELLER', 'SPLIT'])
  decision!: 'FULL_BUYER' | 'FULL_SELLER' | 'SPLIT';

  @ApiPropertyOptional({ description: 'Buyer percentage for SPLIT decisions (integer 1–99)', minimum: 1, maximum: 99 })
  @ValidateIf((o) => o.decision === 'SPLIT')
  @Type(() => Number)
  @IsInt({ message: 'buyerPercent must be an integer' })
  @Min(1)
  @Max(99)
  buyerPercent?: number;

  @ApiPropertyOptional({ description: 'Seller percentage for SPLIT decisions (integer 1–99)', minimum: 1, maximum: 99 })
  @ValidateIf((o) => o.decision === 'SPLIT')
  @Type(() => Number)
  @IsInt({ message: 'sellerPercent must be an integer' })
  @Min(1)
  @Max(99)
  sellerPercent?: number;
}
