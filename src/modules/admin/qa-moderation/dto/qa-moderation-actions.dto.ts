import { IsString, IsIn, IsOptional, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { QA_REPORT_TARGETS } from '../qa-moderation.types';

export class QaRedactDto {
  @ApiProperty({ description: 'Tipe target.', enum: QA_REPORT_TARGETS })
  @IsString()
  @IsIn(QA_REPORT_TARGETS as unknown as string[])
  targetType!: string;

  @ApiProperty({ description: 'ID pertanyaan/komentar target.' })
  @IsString()
  targetId!: string;
}

export class QaAssignDto {
  @ApiProperty({
    description: 'ID admin penerima assignment/handoff. Kosongkan (null) untuk melepas assignment.',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  adminId?: string | null;
}

export class QaAppealReviewDto {
  @ApiProperty({ description: 'Keputusan atas keberatan.', enum: ['APPROVED', 'REJECTED'] })
  @IsString()
  @IsIn(['APPROVED', 'REJECTED'])
  decision!: 'APPROVED' | 'REJECTED';

  @ApiPropertyOptional({ description: 'Catatan review internal (opsional).', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class QaDeleteRequestDto {
  @ApiProperty({ description: 'Alasan penghapusan permanen (internal).', maxLength: 1000 })
  @IsString()
  @MaxLength(1000)
  reason!: string;
}

export class QaDeleteDecisionDto {
  @ApiPropertyOptional({
    description: 'Catatan keputusan approve/reject (opsional) — hanya terlihat admin.',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class QaReportResolveDto {
  @ApiProperty({ description: 'Resolusi laporan.', enum: ['DISMISSED', 'ACTION_TAKEN'] })
  @IsString()
  @IsIn(['DISMISSED', 'ACTION_TAKEN'])
  resolution!: 'DISMISSED' | 'ACTION_TAKEN';

  @ApiPropertyOptional({ description: 'Catatan resolusi internal (opsional).', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
