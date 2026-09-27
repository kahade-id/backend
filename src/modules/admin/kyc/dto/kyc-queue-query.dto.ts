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
