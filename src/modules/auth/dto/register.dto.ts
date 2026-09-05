import {
  IsEmail, IsString, IsOptional, MinLength, MaxLength, Matches,
  IsDateString, IsEnum, IsNotEmpty, IsNumber, IsUUID, Min, Max,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export enum GenderDto {
  MALE              = 'MALE',
  FEMALE            = 'FEMALE',
  OTHER             = 'OTHER',
  PREFER_NOT_TO_SAY = 'PREFER_NOT_TO_SAY',
}

const PASSWORD_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()\-_=+{};:,<.>/?\\|'"`~[\]@])/;
const PASSWORD_MSG =
  'Password must contain at least 1 uppercase, 1 lowercase, 1 digit, and 1 special character';

const USERNAME_REGEX = /^[a-zA-Z0-9._]+$/;
const USERNAME_MSG =
  'Username must be 3-30 characters and contain only letters, numbers, dots, and underscores';

export class RegisterDto {
  @ApiProperty({ description: 'Full name', minLength: 2, maxLength: 60 })
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(60)
  @Matches(/^[^<>]*$/, { message: 'Name must not contain < or > characters' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  fullName!: string;

  @ApiPropertyOptional({ description: 'Unique username (3-30 characters)', minLength: 3, maxLength: 30 })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(30)
  @Matches(USERNAME_REGEX, { message: USERNAME_MSG })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase() : value))
  username?: string;

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

  @ApiProperty({ description: 'Confirm password', minLength: 12, maxLength: 72 })
  @IsString()
  @MinLength(12)
  @MaxLength(72)
  confirmPassword!: string;

  @ApiPropertyOptional({ description: 'Phone number (E.164 or local Indonesian format, e.g. 08xx)', maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Matches(/^(\+62|62|0)8[1-9][0-9]{7,10}$/, { message: 'Invalid Indonesian phone number format' })
  phoneNumber?: string;

  @ApiPropertyOptional({ description: 'Date of birth (ISO 8601: YYYY-MM-DD)', example: '1995-06-15' })
  @IsOptional()
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
  dateOfBirth?: string;

  @ApiPropertyOptional({ description: 'Gender', enum: GenderDto })
  @IsOptional()
  @IsEnum(GenderDto, { message: 'Invalid gender value' })
  gender?: GenderDto;

  @ApiPropertyOptional({ description: 'Referral code (optional)', maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  referralCode?: string;

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
