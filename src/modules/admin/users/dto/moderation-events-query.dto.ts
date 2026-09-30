import { IsString, IsOptional, IsIn, MaxLength, IsISO8601 } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../../../common/dto/pagination.dto';

/** Jenis event pada timeline moderasi pengguna. */
export const MODERATION_EVENT_TYPES = [
  'ban',
  'unban',
  'kyc_decision',
  'report_resolved',
  'flag_raised',
  'flag_cleared',
  'admin_action',
] as const;

export type ModerationEventType = (typeof MODERATION_EVENT_TYPES)[number];

/**
 * GAP-E — query timeline moderasi pengguna.
 * Filter: jenis event, aktor (id admin), rentang waktu.
 * ADM-005: `kind` memfilter sumber event (`system` = otomatis, `admin`).
 * BAI-061/BAI-073: `page`/`limit` dipaginasi nyata di service (bukan selalu
 * 200 pertama) — extend PaginationDto.
 */
export class ModerationEventsQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    description: 'Filter sumber event: system (sinyal otomatis) atau admin.',
    enum: ['system', 'admin'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['system', 'admin'])
  kind?: 'system' | 'admin';

  @ApiPropertyOptional({ description: 'Filter jenis event.', enum: MODERATION_EVENT_TYPES })
  @IsOptional()
  @IsString()
  @IsIn(MODERATION_EVENT_TYPES as unknown as string[])
  event?: ModerationEventType;

  @ApiPropertyOptional({ description: 'Filter aktor: id admin pelaksana.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  actor?: string;

  @ApiPropertyOptional({ description: 'Batas awal (ISO 8601).' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Batas akhir (ISO 8601).' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}
