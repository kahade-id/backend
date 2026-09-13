import { IsBoolean, IsOptional, IsInt, Min, Max } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Arsip / buka arsip percakapan.
 *
 * Bersifat per user: mengarsipkan percakapan tidak menghilangkannya dari
 * daftar chat lawan bicara.
 */
export class ArchiveRoomDto {
  @ApiPropertyOptional({ description: 'true to archive, false to unarchive', default: true })
  @IsOptional()
  @IsBoolean()
  archived?: boolean = true;
}

const MAX_MUTE_HOURS = 24 * 30;

export class MuteRoomDto {
  @ApiPropertyOptional({ description: 'true to mute, false to unmute', default: true })
  @IsOptional()
  @IsBoolean()
  muted?: boolean = true;

  @ApiPropertyOptional({
    description: 'Mute duration in hours. Omit to mute indefinitely.',
    minimum: 1,
    maximum: MAX_MUTE_HOURS,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_MUTE_HOURS)
  durationHours?: number;
}
