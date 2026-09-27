import { IsString, IsOptional, IsBoolean, MinLength, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * GAP-E (G380) — query ekspor CSV pengguna yang diperkuat.
 * `reason` WAJIB (dicatat di UserExportAudit + AdminAuditLog).
 */
export class UserExportQueryDto {
  @ApiProperty({ description: 'Alasan ekspor (wajib, min 10 karakter) — tercatat di audit.' })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({
    description: 'Kolom CSV dipisah koma. Default kolom minimal bila kosong.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  columns?: string;

  @ApiPropertyOptional({
    description: 'Samarkan email & nomor HP (default true). Hanya role allowlist yang boleh unmask.',
    default: true,
  })
  @IsOptional()
  @Transform(({ value }) => value === 'false' || value === '0' ? false : value === 'true' || value === '1' ? true : value)
  @IsBoolean()
  mask?: boolean;

  @ApiPropertyOptional({ description: 'Filter pencarian (nama/email/username/userId/HP).' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ description: 'Filter status: active|banned|kyc_approved|kyc_pending|flagged.' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  status?: string;
}
