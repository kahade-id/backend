import { IsString, MaxLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AdminVerify2faDto {
  @ApiProperty({ description: 'Temporary token issued by /admin/auth/login', maxLength: 512 })
  @IsString()
  @MaxLength(512)
  tempToken!: string;

  @ApiProperty({ description: 'TOTP code from authenticator app', minLength: 6, maxLength: 6 })
  @IsString()
  @Matches(/^\d{6}$/)
  totpToken!: string;
}
