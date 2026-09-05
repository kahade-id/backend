import { IsOptional, IsString, IsIn } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../../../common/dto/pagination.dto';

const RATING_STARS = ['1', '2', '3', '4', '5'];
const BOOLEAN_FILTERS = ['true', 'false'];

export class RatingListQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Filter by star rating' })
  @IsOptional()
  @IsString()
  @IsIn(RATING_STARS)
  stars?: string;

  @ApiPropertyOptional({ description: 'Filter by flagged status' })
  @IsOptional()
  @IsString()
  @IsIn(BOOLEAN_FILTERS)
  flagged?: string;
}
