import { IsString, IsNotEmpty, MaxLength, Length, IsOptional, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class Verify2faLoginDto {
  @ApiProperty({ description: 'Temporary token from login', maxLength: 512 })
  @IsString()
  @MaxLength(512)
  tempToken!: string;

  @ApiProperty({ description: 'Six-digit TOTP code or 10–16 character backup code', minLength: 6, maxLength: 16 })
  @IsString()
  @Length(6, 16)
  @Matches(/^(?:\d{6}|[A-Za-z0-9]{10,16})$/, {
    message: 'code must be a six-digit authenticator code or a 10–16 character backup code',
  })
  code!: string;

  @ApiProperty({ description: 'Device identifier', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  deviceId!: string;

  @ApiPropertyOptional({ description: 'Device information', maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  deviceInfo?: string;
}
