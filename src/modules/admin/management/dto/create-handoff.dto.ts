import { IsString, IsOptional, IsIn, IsInt, Min, Max, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

/** GAP-E (G397) — catatan handoff kasus antar petugas admin. */
export class CreateHandoffDto {
  @ApiProperty({ description: 'Jenis kasus.', enum: ['kyc', 'dispute', 'report'] })
  @IsString()
  @IsIn(['kyc', 'dispute', 'report'])
  caseType!: 'kyc' | 'dispute' | 'report';

  @ApiProperty({ description: 'ID kasus (id internal / nomor kasus publik).' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  caseId!: string;

  @ApiProperty({ description: 'ID admin pemberi (from).' })
  @IsString()
  @MaxLength(100)
  fromAdminId!: string;

  @ApiProperty({ description: 'ID admin penerima (to).' })
  @IsString()
  @MaxLength(100)
  toAdminId!: string;

  @ApiPropertyOptional({ description: 'Catatan handoff untuk penerima.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class HandoffQueryDto {
  @ApiProperty({ description: 'Jenis kasus.', enum: ['kyc', 'dispute', 'report', 'user'] })
  @IsString()
  // BAD-013: tambah 'user' — handoff bisa merujuk kasus user umum.
  @IsIn(['kyc', 'dispute', 'report', 'user'])
  caseType!: 'kyc' | 'dispute' | 'report' | 'user';

  @ApiProperty({ description: 'ID kasus.' })
  @IsString()
  @MaxLength(100)
  caseId!: string;

  // BAD-013: paginasi opsional (default page=1, limit=20).
  @ApiPropertyOptional({ description: 'Halaman (default 1).', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: 'Jumlah per halaman (default 20, maks 100).', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
