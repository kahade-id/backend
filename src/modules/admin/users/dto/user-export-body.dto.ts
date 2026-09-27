import { IsString, IsOptional, IsBoolean, IsArray, ArrayMaxSize, MinLength, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * GAP-E (G380) — body POST /v1/admin/users/export.
 * Kontrak yang dipakai admin web (lihat `requestUsersExport`):
 * `reason` WAJIB (min 10 karakter, tercatat di audit),
 * `columns` subset kolom ekspor, `mask` default true.
 */
export class UserExportBodyDto {
  @ApiProperty({ description: 'Alasan ekspor (wajib, min 10 karakter) — tercatat di audit.' })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  reason!: string;

  @ApiPropertyOptional({ description: 'Subset kolom ekspor (lihat EXPORTABLE_USER_COLUMNS di admin). Kosong = default minimal.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  columns?: string[];

  @ApiPropertyOptional({ description: 'Samarkan email & nomor HP (default true). Hanya SUPER_ADMIN boleh false.', default: true })
  @IsOptional()
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
