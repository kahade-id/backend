import { IsOptional, IsString, IsIn, IsInt, Min, Max, IsBoolean } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../../../common/dto/pagination.dto';
import { QA_MODERATION_REASONS, QA_REPORT_TARGETS } from '../qa-moderation.types';
// BAI-034 (audit integrasi 2026-09-30): Transform boolean ketat — JANGAN
// pakai `@Type(() => Boolean)` (Boolean("false") === true).
import { strictBooleanTransform } from '../../showcase-reports/dto/moderation-queue-query.dto';

export class QaModerationQueueQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    description: 'Pencarian teks konten / username (parsial, case-insensitive).',
  })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ description: 'Filter tipe target', enum: QA_REPORT_TARGETS })
  @IsOptional()
  @IsIn(QA_REPORT_TARGETS as unknown as string[])
  targetType?: string;

  @ApiPropertyOptional({
    description: 'Filter reason code laporan pending / aksi moderator.',
    enum: QA_MODERATION_REASONS,
  })
  @IsOptional()
  @IsIn(QA_MODERATION_REASONS as unknown as string[])
  reasonCode?: string;

  @ApiPropertyOptional({
    description: 'answered = sudah dijawab, unanswered = belum dijawab (hanya QUESTION).',
    enum: ['answered', 'unanswered'],
  })
  @IsOptional()
  @IsIn(['answered', 'unanswered'])
  answered?: 'answered' | 'unanswered';

  @ApiPropertyOptional({ description: 'true = hanya item yang punya laporan PENDING.' })
  @IsOptional()
  // BAI-034 — Transform ketat: "?reportedOnly=false" tidak boleh jadi true.
  @Transform(strictBooleanTransform)
  @IsBoolean()
  reportedOnly?: boolean;

  @ApiPropertyOptional({
    description: 'true = hanya item yang tersembunyi (owner maupun moderator).',
  })
  @IsOptional()
  // BAI-034 — Transform ketat: "?hiddenOnly=false" tidak boleh jadi true.
  @Transform(strictBooleanTransform)
  @IsBoolean()
  hiddenOnly?: boolean;

  @ApiPropertyOptional({
    description: 'true = hanya kandidat spam lintas profil (heuristik G440).',
  })
  @IsOptional()
  // BAI-034 — Transform ketat: "?spamOnly=false" tidak boleh jadi true.
  @Transform(strictBooleanTransform)
  @IsBoolean()
  spamOnly?: boolean;

  @ApiPropertyOptional({ description: 'Batas kandidat spam: min profil berbeda dalam 24 jam.', minimum: 2, maximum: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(20)
  spamProfileThreshold?: number = 3;
}
