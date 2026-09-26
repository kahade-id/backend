import { IsOptional, IsString, IsIn } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../../../common/dto/pagination.dto';

const SHOWCASE_REPORT_STATUSES = [
  'PENDING',
  'UNDER_REVIEW',
  'RESOLVED_ACTION_TAKEN',
  'RESOLVED_NO_ACTION',
  'DISMISSED',
];

export class ShowcaseReportListQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Filter by report status' })
  @IsOptional()
  @IsString()
  @IsIn(SHOWCASE_REPORT_STATUSES)
  status?: string;
}
