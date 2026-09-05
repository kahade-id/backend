import { IsOptional, IsString, IsIn } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class ListNotificationsDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Filter by read status', enum: ['true', 'false'] })
  @IsOptional()
  @IsString()
  isRead?: string;

  @ApiPropertyOptional({ description: 'Filter by category', enum: ['TRANSAKSI', 'PROMOSI', 'INFORMASI'] })
  @IsOptional()
  @IsString()
  @IsIn(['TRANSAKSI', 'PROMOSI', 'INFORMASI', 'transaksi', 'promosi', 'informasi'])
  category?: string;
}
