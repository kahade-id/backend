import { IsString, IsIn, IsOptional, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { QA_MODERATION_REASONS, QA_REPORT_TARGETS } from '../../admin/qa-moderation/qa-moderation.types';

export class QaReportDto {
  @ApiProperty({ description: 'Alasan laporan.', enum: QA_MODERATION_REASONS })
  @IsString()
  @IsIn(QA_MODERATION_REASONS as unknown as string[])
  reasonCode!: string;

  @ApiPropertyOptional({ description: 'Catatan tambahan (opsional).', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class QaAppealDto {
  @ApiProperty({ description: 'Tipe target.', enum: QA_REPORT_TARGETS })
  @IsString()
  @IsIn(QA_REPORT_TARGETS as unknown as string[])
  targetType!: string;

  @ApiProperty({ description: 'ID pertanyaan/komentar yang disembunyikan moderator.' })
  @IsString()
  targetId!: string;

  @ApiProperty({ description: 'Alasan keberatan (min 10 karakter).', minLength: 10, maxLength: 1000 })
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  reason!: string;
}
