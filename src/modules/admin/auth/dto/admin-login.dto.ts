import { IsEmail, IsString, IsOptional, MinLength, MaxLength, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AdminLoginDto {
  @ApiProperty({ description: 'Admin email address' })
  @IsEmail()
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  email!: string;

  @ApiProperty({ description: 'Admin password', minLength: 8, maxLength: 72 })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;

  @ApiPropertyOptional({ description: 'TOTP token for 2FA', minLength: 6, maxLength: 6 })
  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/)
  totpToken?: string;
}
