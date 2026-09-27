import { IsOptional, IsString, IsIn, IsNumber, Min, Max } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type, Transform } from 'class-transformer';
import { PaginationDto } from '../../../../common/dto/pagination.dto';

export class KycQueueQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  @IsIn(['PENDING', 'APPROVED', 'REJECTED', 'REVOKED'])
  status?: string;

  @ApiPropertyOptional({ description: 'Filter SLA: true = hanya yang lewat SLA, false = yang belum' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  slaBreached?: boolean;

  /**
   * ADM-006: filter status SLA di sisi server (menggantikan filter
   * client-side di UI yang merusak total/paginasi).
   * OK | MENDEKATI (sisa < 20%) | BREACHED | PAUSED.
   * OK/MENDEKATI dihitung dari umur `slaStartedAt ?? createdAt` terhadap
   * config efektif — aproksimasi filter; tampilan `sla` per baris tetap
   * memakai perhitungan live (business hours + jeda).
   */
  @ApiPropertyOptional({
    description: 'Filter status SLA per baris (server-side).',
    enum: ['OK', 'MENDEKATI', 'BREACHED', 'PAUSED'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['OK', 'MENDEKATI', 'BREACHED', 'PAUSED'])
  slaStatus?: 'OK' | 'MENDEKATI' | 'BREACHED' | 'PAUSED';

  /**
   * ADM-015: pencarian teks antrean — kycId, email, nama, userId, username.
   */
  @ApiPropertyOptional({ description: 'Cari antrean: kycId / nama / email / userId / username.' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Umur antrean minimum (jam, dihitung dari slaStartedAt)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(8760)
  minAgeHours?: number;

  @ApiPropertyOptional({ description: 'Umur antrean maksimum (jam, dihitung dari slaStartedAt)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(8760)
  maxAgeHours?: number;

  @ApiPropertyOptional({ description: 'Filter reviewer yang ditugaskan (ID admin) atau "unassigned"' })
  @IsOptional()
  @IsString()
  assigned?: string;
}
