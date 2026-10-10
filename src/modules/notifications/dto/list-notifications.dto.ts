import { IsOptional, IsString, IsIn } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class ListNotificationsDto extends PaginationDto {
  // Audit 2026-10-10 (BE-15): selain 'true'/'false' dulu diabaikan diam-diam
  // (klien mengirim `isRead=1` → daftar penuh tanpa filter, tanpa error).
  @ApiPropertyOptional({ description: 'Filter by read status', enum: ['true', 'false'] })
  @IsOptional()
  @IsString()
  @IsIn(['true', 'false'], { message: 'isRead must be "true" or "false"' })
  isRead?: string;

  @ApiPropertyOptional({ description: 'Filter by category', enum: ['TRANSAKSI', 'PROMOSI', 'INFORMASI'] })
  @IsOptional()
  @IsString()
  @IsIn(['TRANSAKSI', 'PROMOSI', 'INFORMASI', 'transaksi', 'promosi', 'informasi'])
  category?: string;
}
