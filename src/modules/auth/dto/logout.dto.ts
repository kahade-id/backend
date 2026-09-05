import { IsOptional, IsBoolean } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class LogoutDto {
  @ApiPropertyOptional({ description: 'Logout from all devices', default: false })
  @IsOptional()
  @IsBoolean()
  logoutAll?: boolean = false;
}
