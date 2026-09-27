import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Batas bulk = batas yang ditegakkan controller (slice 50). UI memakai konstanta yang sama. */
export const BULK_BUSINESS_VERIFICATION_MAX = 50;

export class BulkApproveBusinessVerificationDto {
  @ApiProperty({ description: 'Daftar verificationId/id (maks 50 per batch)', type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_BUSINESS_VERIFICATION_MAX)
  @IsString({ each: true })
  verificationIds!: string[];

  @ApiPropertyOptional({ description: 'Catatan internal yang sama untuk seluruh batch' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class BulkRejectBusinessVerificationDto {
  @ApiProperty({ description: 'Daftar verificationId/id (maks 50 per batch)', type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_BUSINESS_VERIFICATION_MAX)
  @IsString({ each: true })
  verificationIds!: string[];

  @ApiProperty({
    description: 'Alasan penolakan WAJIB — sama untuk seluruh batch, dikirim ke tiap pemohon',
    minLength: 10,
    maxLength: 500,
  })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({ description: 'Catatan internal yang sama untuk seluruh batch' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
