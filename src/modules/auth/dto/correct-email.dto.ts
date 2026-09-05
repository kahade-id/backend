import { IsEmail, IsString, IsNotEmpty, IsOptional, MaxLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export class CorrectEmailDto {
  @ApiProperty({ description: 'New email address', maxLength: 254 })
  @IsEmail()
  @MaxLength(254)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase().trim() : value))
  newEmail!: string;

  @ApiProperty({ description: 'Current password for verification', maxLength: 72 })
  @IsString()
  @IsNotEmpty({ message: 'Password is required' })
  @MaxLength(72)
  password!: string;

  @ApiProperty({ description: 'Authenticator or backup code when 2FA is enabled', required: false, maxLength: 16 })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  @Matches(/^(?:\d{6}|[A-Za-z0-9]{10,16})$/, {
    message: 'mfaCode must be a six-digit authenticator code or a 10–16 character backup code',
  })
  mfaCode?: string;
}
