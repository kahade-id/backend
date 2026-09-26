import { IsOptional, IsString, MaxLength } from 'class-validator';
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

  @ApiPropertyOptional({ description: 'Cari berdasarkan username / email / nama / userId', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}
