import { IsString, IsNotEmpty, MaxLength, IsOptional, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ConfirmUploadDto {
  @ApiProperty({ example: 'uploads/kyc-ktp/usr123/1234567890-photo.jpg' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  fileKey!: string;

  @ApiPropertyOptional({ example: 'a1b2c3...', description: 'SHA-256 hash of the uploaded file for integrity verification' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-f0-9]{64}$/, { message: 'sha256 must be a valid 64-character hex string' })
  sha256?: string;
}
