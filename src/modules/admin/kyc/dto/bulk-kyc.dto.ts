import { IsString, IsOptional, IsArray, ArrayMinSize, ArrayMaxSize, IsIn, MinLength, MaxLength, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const BULK_MAX_IDS = 50;

export class BulkApproveKycDto {
  @ApiProperty({ description: 'Daftar ID KYC (maks 50)', maxItems: BULK_MAX_IDS })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_MAX_IDS)
  @IsString({ each: true })
  kycIds!: string[];

  @ApiPropertyOptional({ description: 'Catatan internal (opsional)', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @Matches(/\S/, { message: 'notes must contain at least one non-whitespace character' })
  @MaxLength(1000)
  notes?: string;

  @ApiPropertyOptional({
    description: 'Status yang diharapkan saat daftar dimuat — aksi dibatalkan per ID bila status kini berbeda',
    enum: ['PENDING'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['PENDING'])
  expectedStatus?: string;
}

export class BulkRejectKycDto {
  @ApiProperty({ description: 'Daftar ID KYC (maks 50)', maxItems: BULK_MAX_IDS })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_MAX_IDS)
  @IsString({ each: true })
  kycIds!: string[];

  @ApiProperty({ description: 'Alasan penolakan — wajib', minLength: 10, maxLength: 500 })
  @IsString()
  @MinLength(10)
  @Matches(/\S/, { message: 'reason must contain at least one non-whitespace character' })
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({ description: 'Catatan internal (opsional)', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @Matches(/\S/, { message: 'notes must contain at least one non-whitespace character' })
  @MaxLength(1000)
  notes?: string;

  @ApiPropertyOptional({
    description: 'Status yang diharapkan saat daftar dimuat — aksi dibatalkan per ID bila status kini berbeda',
    enum: ['PENDING'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['PENDING'])
  expectedStatus?: string;
}
