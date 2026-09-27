import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

/**
 * G411 — antrean prioritas moderasi: filter risiko + badge overdue.
 */
export class ModerationQueueQueryDto {
  @ApiPropertyOptional({ description: 'Halaman', default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ description: 'Batas per halaman', default: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @ApiPropertyOptional({
    description: 'Filter tier risiko (dihitung on-the-fly bila belum di-assign)',
    enum: ['HIGH', 'MEDIUM', 'LOW'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['HIGH', 'MEDIUM', 'LOW'])
  riskTier?: string;

  @ApiPropertyOptional({ description: 'Hanya yang melewati SLA', default: false })
  @Type(() => Boolean)
  @IsOptional()
  overdueOnly?: boolean;

  @ApiPropertyOptional({ description: 'Urutkan: risk | oldest | newest', default: 'risk' })
  @IsOptional()
  @IsString()
  @IsIn(['risk', 'oldest', 'newest'])
  sort?: string;

  @ApiPropertyOptional({ description: 'Filter assignee (admin id)' })
  @IsOptional()
  @IsString()
  assigneeAdminId?: string;
}
