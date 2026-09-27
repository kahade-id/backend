import { IsOptional, IsEnum, IsString, MaxLength, IsNumber, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReconciliationFindingStatus } from '@prisma/client';
import { PaginationDto } from '../../../../common/dto/pagination.dto';

export class FindingsQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: ReconciliationFindingStatus, description: 'Filter by finding status' })
  @IsOptional()
  @IsEnum(ReconciliationFindingStatus)
  status?: ReconciliationFindingStatus;

  @ApiPropertyOptional({ description: 'Minimum absolute difference in IDR' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minDifferenceIdr?: number;

  @ApiPropertyOptional({ description: 'Only findings created at most this many days ago' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  maxAgeDays?: number;

  @ApiPropertyOptional({ description: 'Filter by violated invariant marker' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  invariant?: string;

  @ApiPropertyOptional({ description: 'Only urgent findings (|difference| above urgent threshold)' })
  @IsOptional()
  @Type(() => Boolean)
  urgentOnly?: boolean;
}

export class AcknowledgeFindingDto {
  @ApiProperty({
    enum: ['INVESTIGATING', 'RESOLVED', 'ACCEPTED'],
    description: 'Target status. Allowed transitions: NEW → INVESTIGATING|RESOLVED|ACCEPTED, INVESTIGATING → RESOLVED|ACCEPTED.',
  })
  @IsEnum(['INVESTIGATING', 'RESOLVED', 'ACCEPTED'] as const)
  status!: 'INVESTIGATING' | 'RESOLVED' | 'ACCEPTED';

  @ApiPropertyOptional({ description: 'Catatan tindak lanjut (maks 2000 karakter)' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class BatchDiscrepanciesQueryDto extends PaginationDto {}
