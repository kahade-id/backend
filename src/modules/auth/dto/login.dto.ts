import { IsEmail, IsString, IsNotEmpty, IsOptional, IsNumber, IsUUID, MaxLength, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export class LoginDto {
  @ApiProperty({ description: 'User email address', maxLength: 254 })
  @IsEmail()
  @MaxLength(254)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase().trim() : value))
  email!: string;

  @ApiProperty({ description: 'User password', maxLength: 72 })
  @IsString()
  @IsNotEmpty({ message: 'Password is required' })
  @MaxLength(72)
  password!: string;

  @ApiProperty({ description: 'Device identifier', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  deviceId!: string;

  @ApiPropertyOptional({ description: 'Device information (User-Agent)', maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  deviceInfo?: string;

  @ApiPropertyOptional({ description: 'Captcha challenge ID' })
  @IsOptional()
  @IsUUID()
  captchaId?: string;

  @ApiPropertyOptional({ description: 'Captcha answer (X position 0-100)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  captchaAnswer?: number;
}
