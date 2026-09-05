import { IsString, IsNotEmpty, IsEnum, IsOptional, IsArray, MaxLength, MinLength, ArrayMaxSize, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReportCategory } from '@prisma/client';

const STORAGE_URL_PATTERN = /^https:\/\/cdn\.kahade\.id\//;

export class ReportUserDto {
  @ApiProperty({ enum: ReportCategory, description: 'Report category' })
  @IsEnum(ReportCategory, { message: 'Invalid report category' })
  category!: ReportCategory;

  @ApiProperty({ description: 'Report description', minLength: 20, maxLength: 500 })
  @IsString()
  @IsNotEmpty({ message: 'Report description is required' })
  @MinLength(20, { message: 'Report reason must be at least 20 characters to provide sufficient context' })
  @MaxLength(500, { message: 'Description must be at most 500 characters' })
  description!: string;

  @ApiPropertyOptional({ description: 'Evidence URLs (must be platform storage URLs)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10, { message: 'Maximum 10 evidence URLs' })
  @Matches(STORAGE_URL_PATTERN, { each: true, message: 'Evidence URLs must be platform storage URLs (https://cdn.kahade.id/)' })
  @MaxLength(500, { each: true, message: 'URL is too long' })
  evidenceUrls?: string[];

  @ApiPropertyOptional({ description: 'Related order ID' })
  @IsOptional()
  @IsString()
  relatedOrderId?: string;
}
