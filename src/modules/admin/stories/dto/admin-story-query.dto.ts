import { IsIn, IsOptional, IsString, MaxLength, IsDateString } from 'class-validator';
import { Transform } from 'class-transformer';
import { PaginationDto } from '../../../../common/dto/pagination.dto';

const STORY_KINDS = ['image', 'video', 'text'];
const STORY_STATUSES = ['all', 'active', 'expired', 'deleted', 'hidden', 'banned'];
const REPORT_STATUSES = ['open', 'in_review', 'resolved_action', 'resolved_dismissed'];

export class AdminStoryListQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  authorUserId?: string;

  @IsOptional()
  @IsIn(STORY_KINDS)
  kind?: 'image' | 'video' | 'text';

  @IsOptional()
  @IsIn(STORY_STATUSES)
  status?: (typeof STORY_STATUSES)[number];

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

export class AdminStoryReportListQueryDto extends PaginationDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @IsIn(REPORT_STATUSES)
  status?: (typeof REPORT_STATUSES)[number];
}
