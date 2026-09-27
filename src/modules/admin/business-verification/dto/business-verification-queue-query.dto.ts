import { IsIn, IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../../../common/dto/pagination.dto';
import { LEGAL_ENTITY_TYPES } from '../legal-entity.util';

export class BusinessVerificationQueueQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    enum: ['PENDING', 'APPROVED', 'REJECTED', 'REVOKED'],
    description: 'Filter queue by status. Default: semua status.',
  })
  @IsOptional()
  @IsString()
  @IsIn(['PENDING', 'APPROVED', 'REJECTED', 'REVOKED'])
  status?: string;

  @ApiPropertyOptional({
    enum: LEGAL_ENTITY_TYPES,
    description:
      'Filter jenis badan hukum (diturunkan dari awalan businessName; lihat legal-entity.util.ts).',
  })
  @IsOptional()
  @IsString()
  @IsIn(LEGAL_ENTITY_TYPES)
  legalEntityType?: string;

  @ApiPropertyOptional({
    enum: ['true', 'false'],
    description:
      'Filter kelengkapan dokumen: minimal 1 dokumen terunggah DAN (nomor akta ATAU nomor SIUP/NIB) terisi.',
  })
  @IsOptional()
  @IsString()
  @IsIn(['true', 'false'])
  docsComplete?: 'true' | 'false';

  @ApiPropertyOptional({
    enum: ['true'],
    description: '"Menunggu dokumen tambahan": status PENDING dan dokumen belum lengkap.',
  })
  @IsOptional()
  @IsString()
  @IsIn(['true'])
  awaitingDocs?: 'true';

  @ApiPropertyOptional({
    enum: ['true'],
    description:
      'Alarm legalitas kedaluwarsa: status APPROVED dan approvedAt lebih tua dari ' +
      'LEGALITY_VALIDITY_DAYS (masa berlaku verifikasi).',
  })
  @IsOptional()
  @IsString()
  @IsIn(['true'])
  legalitasExpired?: 'true';
}
