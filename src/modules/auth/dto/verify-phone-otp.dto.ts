import { IsString, IsNotEmpty, MaxLength, Matches, IsOptional, Length } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { DEVICE_ID_MESSAGE, DEVICE_ID_PATTERN, normalizeDeviceId } from './device-id.validation';

export class VerifyPhoneOtpDto {
  @ApiProperty({ description: 'Indonesian phone number', maxLength: 20 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  @Matches(/^(\+62|62|0)8[1-9][0-9]{7,10}$/, { message: 'Invalid Indonesian phone number format' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.replace(/[\s\-.]/g, '') : value))
  phoneNumber!: string;

  @ApiProperty({ description: '6-digit OTP code' })
  @IsString()
  @IsNotEmpty()
  @Length(6, 6, { message: 'OTP must be exactly 6 digits' })
  @Matches(/^[0-9]{6}$/, { message: 'OTP must contain only digits' })
  code!: string;

  @ApiProperty({ description: 'Device identifier', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  @Matches(DEVICE_ID_PATTERN, { message: DEVICE_ID_MESSAGE })
  @Transform(({ value }: { value: unknown }) => normalizeDeviceId(value))
  deviceId!: string;

  @ApiPropertyOptional({ description: 'Device information', maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  deviceInfo?: string;
}
