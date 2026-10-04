import { IsOptional, IsString, IsEnum } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { UserAccountType } from '@prisma/client';
import { PaginationDto } from '../../../../common/dto/pagination.dto';

export class UserListQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Search by name or email' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Filter by status' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ enum: UserAccountType, description: 'Filter by account type (PERSONAL/BUSINESS)' })
  @IsOptional()
  @IsEnum(UserAccountType, { message: 'accountType must be PERSONAL or BUSINESS' })
  accountType?: UserAccountType;

  @ApiPropertyOptional({ description: 'Sort by field' })
  @IsOptional()
  @IsString()
  sortBy?: string;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], description: 'Sort order' })
  @IsOptional()
  @IsString()
  sortOrder?: 'asc' | 'desc';
}
