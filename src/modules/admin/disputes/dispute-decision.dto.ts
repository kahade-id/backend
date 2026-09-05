import { IsString, MinLength, MaxLength, IsEnum, IsInt, Min, Max, ValidateIf, Matches } from 'class-validator';
import { BadRequestException } from '@nestjs/common';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class DisputeDecisionDto {
  @ApiProperty({ enum: ['FULL_BUYER', 'FULL_SELLER', 'SPLIT'], description: 'Dispute decision' })
  @IsEnum(['FULL_BUYER', 'FULL_SELLER', 'SPLIT'])
  decision!: 'FULL_BUYER' | 'FULL_SELLER' | 'SPLIT';

  @ApiProperty({ description: 'Decision notes for audit documentation', minLength: 100, maxLength: 5000 })
  @IsString()
  @MinLength(100, { message: 'Decision notes must be at least 100 characters to ensure adequate audit documentation' })
  @Matches(/\S/, { message: 'Decision notes must contain at least one non-whitespace character' })
  @MaxLength(5000)
  decisionNotes!: string;

  @ApiPropertyOptional({ description: 'Buyer percentage for SPLIT decisions (integer 1–99)', minimum: 1, maximum: 99 })
  @ValidateIf(o => o.decision === 'SPLIT')
  @IsInt({ message: 'buyerPercent must be an integer' })
  @Min(1, { message: 'buyerPercent must be at least 1 for a SPLIT decision' })
  @Max(99, { message: 'buyerPercent must be at most 99 for a SPLIT decision (use FULL_BUYER for 100%)' })
  buyerPercent?: number;

  @ApiPropertyOptional({ description: 'Seller percentage for SPLIT decisions (integer 1–99)', minimum: 1, maximum: 99 })
  @ValidateIf(o => o.decision === 'SPLIT')
  @IsInt({ message: 'sellerPercent must be an integer' })
  @Min(1, { message: 'sellerPercent must be at least 1 for a SPLIT decision' })
  @Max(99, { message: 'sellerPercent must be at most 99 for a SPLIT decision (use FULL_SELLER for 100%)' })
  sellerPercent?: number;
}

export function validateSplitPercents(dto: DisputeDecisionDto): void {
  if (dto.decision === 'SPLIT') {
    const buyer = dto.buyerPercent ?? 0;
    const seller = dto.sellerPercent ?? 0;
    if (buyer + seller !== 100) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_SPLIT_PERCENT,
        message: `SPLIT decision requires buyerPercent + sellerPercent = 100, got ${buyer} + ${seller} = ${buyer + seller}`,
      });
    }
  }
}
