import { IsEnum, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { DEVICE_ID_MESSAGE, DEVICE_ID_PATTERN, normalizeDeviceId } from './device-id.validation';
import { LocationDto } from './location.dto';

export enum OtpTriggerPurpose {
  REGISTER = 'register',
  LOGIN = 'login',
  FORGOT_PASSWORD = 'forgot_password',
  MIGRATE_PHONE = 'migrate_phone',
}

export class RequestOtpTriggerDto {
  @ApiProperty({ description: 'Indonesian phone number (e.g. 08xx or +628xx)', maxLength: 20 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  @Matches(/^(\+62|62|0)8[1-9][0-9]{7,10}$/, { message: 'Invalid Indonesian phone number format' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.replace(/[\s\-.]/g, '') : value))
  phoneNumber!: string;

  @ApiPropertyOptional({ description: 'Stable device identifier that requested the trigger (opsional; bila diisi akan diikat ke token berikutnya)', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Matches(DEVICE_ID_PATTERN, { message: DEVICE_ID_MESSAGE })
  @Transform(({ value }: { value: unknown }) => normalizeDeviceId(value))
  deviceId?: string;

  @ApiProperty({ description: 'Tujuan OTP', enum: OtpTriggerPurpose })
  @IsEnum(OtpTriggerPurpose, { message: 'Purpose must be register, login, forgot_password, or migrate_phone' })
  purpose!: OtpTriggerPurpose;

  @ApiPropertyOptional({
    description: 'Token migrasi dari login (wajib bila purpose=migrate_phone)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  migrationToken?: string;

  @ApiPropertyOptional({ description: 'Lokasi presisi perangkat (opsional)', type: LocationDto })
  @IsOptional()
  // Audit Auth 2026-10-10 (#BE-23): tanpa @ValidateNested, @Min/@Max LocationDto tidak dijalankan.
  @ValidateNested()
  @Type(() => LocationDto)
  location?: LocationDto;
}

export class ConfirmPhoneMigrationDto {
  @ApiProperty({ description: 'Temp token dari verify-otp (scope phone_migration)' })
  @IsString()
  @IsNotEmpty()
  tempToken!: string;

  @ApiProperty({ description: 'Device identifier — harus sama dengan saat trigger', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  @Matches(DEVICE_ID_PATTERN, { message: DEVICE_ID_MESSAGE })
  @Transform(({ value }: { value: unknown }) => normalizeDeviceId(value))
  deviceId!: string;

  @ApiPropertyOptional({ description: 'Lokasi presisi perangkat (opsional)', type: LocationDto })
  @IsOptional()
  // Audit Auth 2026-10-10 (#BE-23): tanpa @ValidateNested, @Min/@Max LocationDto tidak dijalankan.
  @ValidateNested()
  @Type(() => LocationDto)
  location?: LocationDto;
}
