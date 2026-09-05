import { IsString, IsNotEmpty, IsOptional, IsUrl, IsInt, Min, Max, MaxLength, IsArray, ValidateNested, ArrayMaxSize } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class UserLinkItemDto {
  @ApiProperty({ description: 'Platform name (e.g. instagram, twitter, website)', maxLength: 30 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  platform!: string;

  @ApiProperty({ description: 'Link URL', maxLength: 500 })
  @IsUrl({ protocols: ['https'] }, { message: 'Invalid URL — only HTTPS allowed' })
  @MaxLength(500)
  url!: string;

  @ApiPropertyOptional({ description: 'Display label', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  label?: string;

  @ApiPropertyOptional({ description: 'Display order' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20)
  displayOrder?: number;
}

export class UpdateLinksDto {
  @ApiProperty({ description: 'Array of links (replaces all existing)', type: [UserLinkItemDto] })
  @IsArray()
  @ArrayMaxSize(10, { message: 'Maximum 10 links' })
  @ValidateNested({ each: true })
  @Type(() => UserLinkItemDto)
  links!: UserLinkItemDto[];
}
