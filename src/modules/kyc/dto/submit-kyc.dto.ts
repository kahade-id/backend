import { IsString, IsNotEmpty, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SubmitKycDto {
  @ApiProperty({
    description: 'S3 fileKey from confirmed KTP upload (format: uploads/kyc-ktp/{userId}/{filename})',
    example: 'uploads/kyc-ktp/user123/1700000000_abc123.jpg',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^uploads\/kyc-ktp\/[^/]+\/[^/]+$/, {
    message: 'ktpFileKey must be a valid S3 key from a confirmed upload',
  })
  ktpFileKey!: string;

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

  @ApiProperty({ description: 'NIK (exactly 16 digits)', pattern: '^\\d{16}$' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{16}$/, { message: 'NIK must be exactly 16 digits' })
  nik!: string;
}
