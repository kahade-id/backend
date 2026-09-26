import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../../../common/dto/pagination.dto';

const CLAIM_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'PAID'] as const;

export class AdminInsuranceClaimQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: CLAIM_STATUSES, description: 'Filter berdasarkan status klaim' })
  @IsOptional()
  @IsString()
  @IsIn(CLAIM_STATUSES as unknown as string[])
  status?: string;

  @ApiPropertyOptional({ description: 'Cari berdasarkan userId / claimType / orderId', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}

const REVIEW_STATUSES = ['APPROVED', 'REJECTED', 'PAID'] as const;

export class ReviewInsuranceClaimDto {
  @ApiProperty({ enum: REVIEW_STATUSES, description: 'Status baru klaim' })
  @IsString()
  @IsIn(REVIEW_STATUSES as unknown as string[])
  status!: 'APPROVED' | 'REJECTED' | 'PAID';

  @ApiPropertyOptional({ description: 'Catatan admin', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
