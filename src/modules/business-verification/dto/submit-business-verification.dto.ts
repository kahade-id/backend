import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Pengajuan verifikasi badan usaha (badge "Business Verified").
 *
 * Dokumen diupload lebih dulu lewat POST /upload/presigned-url dengan
 * purpose=BUSINESS_DOCUMENT lalu dikonfirmasi lewat POST /upload/confirm —
 * persis alur KYC. Service memverifikasi ownership + konfirmasi tiap fileKey
 * sebelum baris BusinessVerification dibuat.
 */
export class SubmitBusinessVerificationDto {
  @ApiProperty({
    description: 'Nama badan usaha sesuai akta pendirian / NPWP',
    example: 'PT Kawal Hak Dengan Aman',
    minLength: 3,
    maxLength: 150,
  })
  @IsString()
  @MinLength(3)
  @MaxLength(150)
  @Matches(/\S/, { message: 'businessName must contain at least one non-whitespace character' })
  businessName!: string;

  @ApiProperty({
    description:
      'NPWP badan usaha — 15 digit (format lama) atau 16 digit (format NIK). ' +
      'Titik dan strip diizinkan dan akan dinormalisasi.',
    example: '01.234.567.8-901.000',
  })
  @IsString()
  @Matches(/^[0-9.-]{15,25}$/, { message: 'npwpNumber must be 15–16 digits (dots and dashes allowed)' })
  npwpNumber!: string;

  @ApiPropertyOptional({ description: 'Nomor akta pendirian', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  deedNumber?: string;

  @ApiPropertyOptional({ description: 'Nomor SIUP / NIB', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  siupNumber?: string;

  @ApiProperty({
    description:
      'S3 fileKey dari upload yang sudah dikonfirmasi ' +
      '(format: uploads/business-documents/{userId}/{filename}). Maksimal 5 dokumen.',
    example: ['uploads/business-documents/user123/1700000000-abc-npwp.pdf'],
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @Matches(/^uploads\/business-documents\/[^/]+\/[^/]+$/, {
    each: true,
    message: 'documentFileKeys entries must be valid S3 keys from a confirmed BUSINESS_DOCUMENT upload',
  })
  documentFileKeys!: string[];
}
