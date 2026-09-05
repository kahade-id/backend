import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../../../common/dto/pagination.dto';

export class SubscriptionListQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Filter by subscription status' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ description: 'Filter by subscription plan' })
  @IsOptional()
  @IsString()
  plan?: string;
}
