import { IsString, IsNotEmpty, IsEmail, IsEnum, MinLength, MaxLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { AdminRole } from '@prisma/client';

export class CreateAdminDto {
  @ApiProperty({ description: 'Full name of the admin' })
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @Matches(/\S/)
  @MaxLength(60, { message: 'Name must be at most 60 characters' })
  @Matches(/^[^<>]*$/, { message: 'Name must not contain < or > characters' })
  fullName!: string;

  @ApiProperty({ description: 'Email address (must be unique)' })
  @IsEmail({}, { message: 'Invalid email format' })
  @IsNotEmpty()
  email!: string;

  @ApiProperty({ description: 'Initial password (min 12 chars, must contain uppercase, lowercase, number, special char)' })
  @IsString()
  @MinLength(12, { message: 'Password must be at least 12 characters' })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?])/, {
    message: 'Password must contain uppercase, lowercase, digit, and special character',
  })
  password!: string;

  @ApiProperty({ description: 'Admin role', enum: AdminRole })
  @IsEnum(AdminRole, { message: 'Invalid role' })
  role!: AdminRole;
}
