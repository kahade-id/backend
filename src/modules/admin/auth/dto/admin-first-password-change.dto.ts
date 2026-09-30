import { IsString, IsOptional, MinLength, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * AUT-011: body untuk POST /v1/admin/auth/first-password-change (public,
 * memakai tempToken scope admin_password_change dari login). Tidak
 * menerbitkan sesi — klien wajib login ulang dengan password baru.
 */
export class AdminFirstPasswordChangeDto {
  @ApiProperty({ description: 'TempToken scope admin_password_change from /admin/auth/login', maxLength: 512 })
  @IsString()
  @MaxLength(512)
  tempToken!: string;

  @ApiProperty({ description: 'New password (min 12 chars, complexity)', minLength: 12, maxLength: 72 })
  @IsString()
  @MinLength(12)
  @MaxLength(72)
  newPassword!: string;

  @ApiPropertyOptional({ description: 'Device identifier bound to the tempToken at login', maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  deviceId?: string;
}
