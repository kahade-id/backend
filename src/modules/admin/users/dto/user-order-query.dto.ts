import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../../../common/dto/pagination.dto';

export class UserOrderQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Filter by order status' })
  @IsOptional()
  @IsString()
  status?: string;
}
