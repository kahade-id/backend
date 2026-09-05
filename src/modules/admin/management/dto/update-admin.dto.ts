import { IsString, IsOptional, IsEnum, IsBoolean, IsNotEmpty, MinLength, MaxLength, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { AdminRole } from '@prisma/client';

export class UpdateAdminDto {
  @ApiPropertyOptional({ description: 'Full name' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @Matches(/\S/)
  @MaxLength(60, { message: 'Name must be at most 60 characters' })
  @Matches(/^[^<>]*$/, { message: 'Name must not contain < or > characters' })
  fullName?: string;

  @ApiPropertyOptional({ description: 'Admin role', enum: AdminRole })
  @IsOptional()
  @IsEnum(AdminRole, { message: 'Invalid role' })
  role?: AdminRole;

  @ApiPropertyOptional({ description: 'Active status' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
