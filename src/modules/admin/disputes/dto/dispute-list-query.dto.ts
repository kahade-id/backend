import { IsOptional, IsString, IsIn, IsEnum, IsBoolean, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { DisputeCategory } from '@prisma/client';
import { PaginationDto } from '../../../../common/dto/pagination.dto';

const DISPUTE_STATUSES = ['OPEN', 'ASSIGNED', 'UNDER_REVIEW', 'WAITING_RESPONSE', 'ESCALATED', 'RESOLVED'];

export class DisputeListQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Filter by dispute status' })
  @IsOptional()
  @IsString()
  @IsIn(DISPUTE_STATUSES)
  status?: string;

  @ApiPropertyOptional({ description: 'Filter by dispute category', enum: DisputeCategory })
  @IsOptional()
  @IsEnum(DisputeCategory)
  category?: DisputeCategory;

  @ApiPropertyOptional({ description: 'Search by dispute public ID (disputeId) or order public ID (orderId)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  /**
   * AW-001 (perf-fix): hanya sengketa yang BELUM ditugaskan ke admin
   * (`assignedAdminId IS NULL`). Menggantikan pola lama admin yang
   * fetch-all lalu menyaring di browser.
   */
  @ApiPropertyOptional({ description: 'Only disputes not yet assigned to any admin (assignedAdminId IS NULL)' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  unassigned?: boolean;
}
