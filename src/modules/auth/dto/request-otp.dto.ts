import { IsString, IsNotEmpty, IsEnum, MaxLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { DEVICE_ID_MESSAGE, DEVICE_ID_PATTERN, normalizeDeviceId } from './device-id.validation';

export enum OtpMethodDto {
  SMS = 'SMS',
  WHATSAPP = 'WHATSAPP',
}

export class RequestOtpDto {
  @ApiProperty({ description: 'Indonesian phone number (e.g. 08xx or +628xx)', maxLength: 20 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  @Matches(/^(\+62|62|0)8[1-9][0-9]{7,10}$/, { message: 'Invalid Indonesian phone number format' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.replace(/[\s\-.]/g, '') : value))
  phoneNumber!: string;

  @ApiProperty({ description: 'OTP delivery method', enum: OtpMethodDto })
  @IsEnum(OtpMethodDto, { message: 'Method must be SMS or WHATSAPP' })
  method!: OtpMethodDto;

  @ApiProperty({ description: 'Stable device identifier that requested the OTP', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  @Matches(DEVICE_ID_PATTERN, { message: DEVICE_ID_MESSAGE })
  @Transform(({ value }: { value: unknown }) => normalizeDeviceId(value))
  deviceId!: string;
}
