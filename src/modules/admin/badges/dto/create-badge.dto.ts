import { Transform } from 'class-transformer';
import { IsString, IsNotEmpty, IsOptional, IsUrl, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const trimString = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;

export class CreateBadgeDto {
  @ApiProperty({ description: 'Badge name', maxLength: 60 })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name!: string;

  @ApiProperty({ description: 'Badge icon URL', maxLength: 500 })
  @Transform(trimString)
  @IsUrl({}, { message: 'iconUrl must be a valid URL' })
  @IsNotEmpty()
  @MaxLength(500)
  iconUrl!: string;

  @ApiPropertyOptional({ description: 'Badge description', maxLength: 1000 })
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}

export class UpdateBadgeDto {
  @ApiPropertyOptional({ description: 'Badge name', maxLength: 60 })
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name?: string;

  @ApiPropertyOptional({ description: 'Badge icon URL', maxLength: 500 })
  @Transform(trimString)
  @IsOptional()
  @IsUrl({}, { message: 'iconUrl must be a valid URL' })
  @IsNotEmpty()
  @MaxLength(500)
  iconUrl?: string;

  @ApiPropertyOptional({ description: 'Badge description', maxLength: 1000 })
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}
