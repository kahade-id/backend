import { IsString, IsNotEmpty, IsOptional, IsNumber, IsUUID, MaxLength, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { LocationDto } from './location.dto';

export class LoginDto {
  @ApiProperty({ description: 'Username, email, atau nomor HP', maxLength: 254 })
  @IsString()
  @IsNotEmpty({ message: 'Username/email/nomor HP wajib diisi' })
  @MaxLength(254)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  identifier!: string;

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

  @ApiPropertyOptional({ description: 'Lokasi presisi perangkat (opsional)', type: LocationDto })
  @IsOptional()
  @Type(() => LocationDto)
  location?: LocationDto;
}
