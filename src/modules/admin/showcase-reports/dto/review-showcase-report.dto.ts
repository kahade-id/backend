import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const SHOWCASE_REPORT_ACTIONS = [
  'dismiss',
  'takedown',
  'no_action',
  'under_review',
] as const;

export type ShowcaseReportAction = (typeof SHOWCASE_REPORT_ACTIONS)[number];

export class ReviewShowcaseReportDto {
  @ApiProperty({
    description:
      'Aksi moderasi: dismiss (→ DISMISSED), takedown (nonaktifkan item + → RESOLVED_ACTION_TAKEN), no_action (→ RESOLVED_NO_ACTION), under_review (→ UNDER_REVIEW)',
    enum: ['dismiss', 'takedown', 'no_action', 'under_review'],
  })
  @IsString()
  @IsIn(SHOWCASE_REPORT_ACTIONS)
  action!: ShowcaseReportAction;

  @ApiPropertyOptional({ description: 'Catatan resolusi admin' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  resolution?: string;
}
