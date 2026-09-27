import { IsString, IsOptional, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * GAP-E (G279): dokumen pelengkap dari pengguna untuk pengajuan yang sedang
 * pause (admin meminta dokumen tambahan). Minimal satu file key wajib diisi.
 */
export class SupplementDocumentsDto {
  @ApiPropertyOptional({ description: 'FileKey KTP baru (uploads/kyc-ktp/{userId}/{file})' })
  @IsOptional()
  @IsString()
  @Matches(/^uploads\/kyc-ktp\/[^/]+\/[^/]+$/, {
    message: 'ktpFileKey must be a valid key from a confirmed upload',
  })
  ktpFileKey?: string;

  @ApiPropertyOptional({ description: 'FileKey selfie baru (uploads/kyc-selfie/{userId}/{file})' })
  @IsOptional()
  @IsString()
  @Matches(/^uploads\/kyc-selfie\/[^/]+\/[^/]+$/, {
    message: 'selfieFileKey must be a valid key from a confirmed upload',
  })
  selfieFileKey?: string;

  @ApiPropertyOptional({ description: 'FileKey liveness baru (uploads/kyc-liveness/{userId}/{file})' })
  @IsOptional()
  @IsString()
  @Matches(/^uploads\/kyc-liveness\/[^/]+\/[^/]+$/, {
    message: 'livenessFileKey must be a valid key from a confirmed upload',
  })
  livenessFileKey?: string;
}
