import { IsString, IsOptional, MaxLength, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * AUT-001: body untuk POST /v1/admin/auth/mfa/setup — tempToken scope
 * admin_mfa_setup dari login + deviceId untuk binding perangkat.
 */
export class AdminMfaSetupDto {
  @ApiProperty({ description: 'TempToken scope admin_mfa_setup from /admin/auth/login', maxLength: 512 })
  @IsString()
  @MaxLength(512)
  tempToken!: string;

  @ApiPropertyOptional({ description: 'Device identifier bound to the tempToken at login', maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  deviceId?: string;
}
