import { IsOptional, IsBoolean } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdatePrivacyDto {
  @ApiPropertyOptional({ description: 'Profile visibility' })
  @IsOptional()
  @IsBoolean()
  profileVisible?: boolean;

  @ApiPropertyOptional({ description: 'Show online status' })
  @IsOptional()
  @IsBoolean()
  showOnlineStatus?: boolean;
}
