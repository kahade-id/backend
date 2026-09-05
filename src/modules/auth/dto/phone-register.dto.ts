import {
  IsString, IsNotEmpty, IsOptional, MinLength, MaxLength, Matches,
  IsDateString, IsEnum, IsEmail, Length,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { GenderDto } from './register.dto';
import { DEVICE_ID_MESSAGE, DEVICE_ID_PATTERN, normalizeDeviceId } from './device-id.validation';

const USERNAME_REGEX = /^[a-zA-Z0-9._]+$/;
const USERNAME_MSG =
  'Username must be 3-30 characters and contain only letters, numbers, dots, and underscores';

const PASSWORD_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()\-_=+{};:,<.>/?\\|'"`~[\]@])/;
const PASSWORD_MSG =
  'Password must contain at least 1 uppercase, 1 lowercase, 1 digit, and 1 special character';

export class PhoneRegisterDto {
  @ApiProperty({ description: 'Temp token from OTP verification' })
  @IsString()
  @IsNotEmpty()
  tempToken!: string;

  @ApiProperty({ description: 'Full name', minLength: 2, maxLength: 60 })
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(60)
  @Matches(/^[^<>]*$/, { message: 'Name must not contain < or > characters' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  fullName!: string;

  @ApiProperty({ description: 'Unique username (3-30 characters)', minLength: 3, maxLength: 30 })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(30)
  @Matches(USERNAME_REGEX, { message: USERNAME_MSG })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase() : value))
  username!: string;

  @ApiProperty({ description: 'Date of birth (ISO 8601: YYYY-MM-DD)', example: '1995-06-15' })
  @IsDateString({}, { message: 'Invalid date of birth format (use YYYY-MM-DD)' })
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const dob = new Date(value);
    if (isNaN(dob.getTime())) return value;
    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const m = today.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
    if (age < 13) return '__UNDERAGE__';
    if (age > 120) return '__INVALID_AGE__';
    return value;
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Date of birth must be YYYY-MM-DD format and age must be at least 13' })
  dateOfBirth!: string;

  @ApiProperty({ description: 'Gender', enum: GenderDto })
  @IsEnum(GenderDto, { message: 'Invalid gender value' })
  gender!: GenderDto;

  @ApiProperty({ description: 'Email address', maxLength: 254 })
  @IsEmail()
  @MaxLength(254)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase().trim() : value))
  email!: string;

  @ApiProperty({ description: 'Password (min 12 chars, must contain uppercase, lowercase, digit, and special character)', minLength: 12, maxLength: 72 })
  @IsString()
  @MinLength(12)
  @MaxLength(72)
  @Matches(PASSWORD_REGEX, { message: PASSWORD_MSG })
  password!: string;

  @ApiProperty({ description: 'Wallet PIN (6 digits)', minLength: 6, maxLength: 6 })
  @IsString()
  @Length(6, 6, { message: 'PIN must be exactly 6 digits' })
  @Matches(/^\d{6}$/, { message: 'PIN must contain only digits' })
  pin!: string;

  @ApiPropertyOptional({ description: 'Full address', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(/^[^<>]*$/, { message: 'Address must not contain < or > characters' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  address?: string;

  @ApiPropertyOptional({ description: 'Referral code (optional)', maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  referralCode?: string;

  @ApiProperty({ description: 'Device identifier bound to the phone-verification token', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  @Matches(DEVICE_ID_PATTERN, { message: DEVICE_ID_MESSAGE })
  @Transform(({ value }: { value: unknown }) => normalizeDeviceId(value))
  deviceId!: string;
}
