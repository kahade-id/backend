import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../../../common/dto/pagination.dto';

export class ReportQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Filter by report status' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ description: 'Filter by report category' })
  @IsOptional()
  @IsString()
  category?: string;
}
