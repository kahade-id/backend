import { IsString, IsOptional, MaxLength, IsEnum, MinLength, IsBoolean, IsEmail, Matches, IsDateString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { UserAccountType } from '@prisma/client';

export class UpdateProfileDto {
  @ApiPropertyOptional({ description: 'Full name', minLength: 2, maxLength: 60 })
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'Name must be at least 2 characters' })
  @MaxLength(60, { message: 'Name must be at most 60 characters' })
  @Matches(/^[^<>]*$/, { message: 'Name must not contain < or > characters' })
  fullName?: string;

  @ApiPropertyOptional({ description: 'Username (can be changed once per month)', minLength: 3, maxLength: 30 })
  @IsOptional()
  @IsString()
  @MinLength(3, { message: 'Username must be at least 3 characters' })
  @MaxLength(30, { message: 'Username must be at most 30 characters' })
  @Matches(/^[a-zA-Z0-9._]+$/, { message: 'Username may only contain letters, numbers, dots, and underscores' })
  username?: string;

  @ApiPropertyOptional({ description: 'User bio', minLength: 0, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Bio must be at most 500 characters' })
  @Matches(/^[^<>]*$/, { message: 'Bio must not contain < or > characters' })
  bio?: string;

  @ApiPropertyOptional({ enum: UserAccountType, description: 'Account type' })
  @IsOptional()
  @IsEnum(UserAccountType, { message: 'accountType must be PERSONAL or BUSINESS' })
  accountType?: UserAccountType;

  @ApiPropertyOptional({ description: 'Phone number' })
  @IsOptional()
  @IsString()
  @MaxLength(20, { message: 'Phone number must be at most 20 characters' })
  phoneNumber?: string;

  @ApiPropertyOptional({ description: 'Date of birth (ISO date string)' })
  @IsOptional()
  @IsDateString({}, { message: 'Invalid date of birth format (use YYYY-MM-DD)' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Date of birth must be in YYYY-MM-DD format' })
  dateOfBirth?: string;

  @ApiPropertyOptional({ description: 'Gender' })
  @IsOptional()
  @IsString()
  @IsEnum(['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY'], { message: 'Gender must be MALE, FEMALE, OTHER, or PREFER_NOT_TO_SAY' })
  gender?: string;

  @ApiPropertyOptional({ description: 'Contact email (public)' })
  @IsOptional()
  @IsEmail({}, { message: 'Invalid contact email format' })
  contactEmail?: string;

  @ApiPropertyOptional({ description: 'Contact phone (public)' })
  @IsOptional()
  @IsString()
  @MaxLength(20, { message: 'Contact phone must be at most 20 characters' })
  contactPhone?: string;

  @ApiPropertyOptional({ description: 'Show contact email on profile' })
  @IsOptional()
  @IsBoolean()
  showContactEmail?: boolean;

  @ApiPropertyOptional({ description: 'Show contact phone on profile' })
  @IsOptional()
  @IsBoolean()
  showContactPhone?: boolean;

  @ApiPropertyOptional({ description: 'Profile visibility' })
  @IsOptional()
  @IsBoolean()
  profileVisible?: boolean;

  @ApiPropertyOptional({ description: 'Show online status' })
  @IsOptional()
  @IsBoolean()
  showOnlineStatus?: boolean;

  @ApiPropertyOptional({ description: 'Current password (required when changing username, phone, or contact info)' })
  @IsOptional()
  @IsString()
  currentPassword?: string;
}
