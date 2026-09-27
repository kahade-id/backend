import { IsDateString, IsEnum, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { VoucherType } from '@prisma/client';

/** Query ekspor agregat performa voucher (G374): per jenis × periode, tanpa PII. */
export class VoucherPerformanceExportDto {
  @ApiPropertyOptional({ enum: VoucherType, description: 'Filter jenis voucher' })
  @IsOptional()
  @IsEnum(VoucherType)
  voucherType?: VoucherType;

  @ApiPropertyOptional({ description: 'Awal periode (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'Akhir periode (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  to?: string;
}
