import { IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { LocationDto } from '../../auth/dto/location.dto';

/**
 * Eskalasi sengketa ke admin (fungsi "banding" bagi user).
 * deviceLocation opsional — dicatat sebagai DISPUTE_APPEAL di action_locations.
 */
export class EscalateDisputeDto {
  @ApiPropertyOptional({ description: 'Alasan eskalasi/banding', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;

  @ApiPropertyOptional({ description: 'Lokasi presisi perangkat (opsional — null/absent bila user menolak izin GPS)', type: () => LocationDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => LocationDto)
  deviceLocation?: LocationDto | null;
}
