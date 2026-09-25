import { IsString, IsNotEmpty, IsOptional, MaxLength, Matches, ValidateNested } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { DEVICE_ID_MESSAGE, DEVICE_ID_PATTERN, normalizeDeviceId } from './device-id.validation';
import { LocationDto } from './location.dto';

export class ForgotPasswordDto {
  @ApiProperty({ description: 'Nomor HP terdaftar (08xx / +628xx)', maxLength: 20 })
  @IsString()
  @IsNotEmpty({ message: 'Nomor HP wajib diisi' })
  @MaxLength(20)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.replace(/[\s\-.]/g, '') : value))
  identifier!: string;

  @ApiPropertyOptional({ description: 'Device identifier (opsional; dibuatkan bila kosong)', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Matches(DEVICE_ID_PATTERN, { message: DEVICE_ID_MESSAGE })
  @Transform(({ value }: { value: unknown }) => normalizeDeviceId(value))
  deviceId?: string;

  @ApiPropertyOptional({ description: 'Lokasi presisi perangkat (opsional)', type: () => LocationDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => LocationDto)
  location?: LocationDto;
}
