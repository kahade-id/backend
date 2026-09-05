import { IsEnum, IsString, IsNotEmpty, IsInt, Min, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export enum UploadPurpose {
  KYC_KTP = 'KYC_KTP',
  KYC_SELFIE = 'KYC_SELFIE',
  AVATAR = 'AVATAR',
  CHAT_ATTACHMENT = 'CHAT_ATTACHMENT',
  DISPUTE_EVIDENCE = 'DISPUTE_EVIDENCE',
  REPORT_EVIDENCE = 'REPORT_EVIDENCE',
  DELIVERY_PROOF = 'DELIVERY_PROOF',
}

export class PresignedUrlDto {
  @ApiProperty({
    enum: UploadPurpose,
    description: 'Upload purpose determines allowed content types, max file size, and URL expiry duration',
  })
  @IsEnum(UploadPurpose)
  purpose!: UploadPurpose;

  @ApiProperty({ example: 'photo.jpg' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName!: string;

  @ApiProperty({ example: 'image/jpeg' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  contentType!: string;

  @ApiProperty({ example: 102400, description: 'Exact file size in bytes. Must be within the allowed range for the upload purpose.' })
  @IsInt()
  @Min(1024)
  fileSize!: number;
}
