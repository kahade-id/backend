import { IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * AUT-002: body untuk POST /v1/admin/auth/change-password (butuh auth).
 * Kebijakan password admin: min 12 + kompleksitas (divalidasi server-side).
 */
export class AdminChangePasswordDto {
  @ApiProperty({ description: 'Current password (re-authentication)' })
  @IsString()
  @MaxLength(72)
  currentPassword!: string;

  @ApiProperty({ description: 'New password (min 12 chars, complexity)', minLength: 12, maxLength: 72 })
  @IsString()
  @MinLength(12)
  @MaxLength(72)
  newPassword!: string;
}
