import { IsString, IsNotEmpty, Matches, IsOptional, IsEnum, ValidateIf } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum KycDocumentType {
  KTP = 'KTP',
  PASSPORT = 'PASSPORT',
}

export class SubmitKycDto {
  @ApiPropertyOptional({ description: 'Document type: KTP (default) or PASSPORT for WNA', enum: KycDocumentType, default: KycDocumentType.KTP })
  @IsOptional()
  @IsEnum(KycDocumentType)
  documentType?: KycDocumentType;

  @ApiProperty({
    description: 'S3 fileKey from confirmed KTP upload (format: uploads/kyc-ktp/{userId}/{filename}) — required if documentType=KTP',
    example: 'uploads/kyc-ktp/user123/1700000000_abc123.jpg',
  })
  @ValidateIf(o => !o.documentType || o.documentType === KycDocumentType.KTP)
  @IsString()
  @IsNotEmpty()
  @Matches(/^uploads\/kyc-ktp\/[^/]+\/[^/]+$/, {
    message: 'ktpFileKey must be a valid S3 key from a confirmed upload',
  })
  ktpFileKey?: string;

  @ApiPropertyOptional({
    description: 'S3 fileKey for passport upload (format: uploads/kyc-passport/{userId}/{filename}) — required if documentType=PASSPORT',
    example: 'uploads/kyc-passport/user123/1700000000_pass.jpg',
  })
  @ValidateIf(o => o.documentType === KycDocumentType.PASSPORT)
  @IsString()
  @IsNotEmpty()
  @Matches(/^uploads\/kyc-passport\/[^/]+\/[^/]+$/, {
    message: 'passportFileKey must be a valid S3 key from a confirmed upload',
  })
  passportFileKey?: string;

  @ApiProperty({
    description: 'S3 fileKey from confirmed selfie upload (format: uploads/kyc-selfie/{userId}/{filename})',
    example: 'uploads/kyc-selfie/user123/1700000000_def456.jpg',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^uploads\/kyc-selfie\/[^/]+\/[^/]+$/, {
    message: 'selfieFileKey must be a valid S3 key from a confirmed upload',
  })
  selfieFileKey!: string;

  @ApiPropertyOptional({
    description: 'S3 fileKey for liveness check / holding ID photo (format: uploads/kyc-liveness/{userId}/{filename}) — optional but recommended for anti-fraud',
    example: 'uploads/kyc-liveness/user123/1700000000_live.jpg',
  })
  @IsOptional()
  @IsString()
  @Matches(/^uploads\/kyc-liveness\/[^/]+\/[^/]+$/, {
    message: 'livenessFileKey must be a valid S3 key from a confirmed upload',
  })
  livenessFileKey?: string;

  @ApiProperty({ description: 'NIK (exactly 16 digits) for KTP, or passport number for PASSPORT' })
  @IsString()
  @IsNotEmpty()
  nik!: string;
}
