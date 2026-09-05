import { IsString, IsEnum, IsOptional, IsArray, MaxLength, ArrayMaxSize, IsUrl } from 'class-validator';
import { IsValidId } from '../../../common/decorators/is-valid-id.decorator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum ReportCategoryDto {
  FRAUD = 'FRAUD',
  FAKE_IDENTITY = 'FAKE_IDENTITY',
  INAPPROPRIATE_CONTENT = 'INAPPROPRIATE_CONTENT',
  TNC_VIOLATION = 'TNC_VIOLATION',
  MONEY_LAUNDERING = 'MONEY_LAUNDERING',
  SPAM = 'SPAM',
  OTHER = 'OTHER',
}

export class ReportUserSettingsDto {
  @ApiProperty({ description: 'ID of the user being reported' })
  @IsValidId()
  targetId!: string;

  @ApiProperty({ enum: ReportCategoryDto, description: 'Report category' })
  @IsEnum(ReportCategoryDto)
  category!: ReportCategoryDto;

  @ApiProperty({ description: 'Report description', maxLength: 500 })
  @IsString()
  @MaxLength(500)
  description!: string;

  @ApiPropertyOptional({ description: 'Evidence URLs', type: [String], maxItems: 10 })
  @IsOptional()
  @IsArray()
  @IsUrl({ protocols: ['http', 'https'] }, { each: true, message: 'Each evidence URL must be a valid HTTP(S) URL' })
  @MaxLength(500, { each: true })
  @ArrayMaxSize(10)
  evidenceUrls?: string[];

  @ApiPropertyOptional({ description: 'Related order ID' })
  @IsOptional()
  @IsValidId({ message: 'relatedOrderId must be a valid ID' })
  relatedOrderId?: string;

  @ApiPropertyOptional({ description: 'Related message ID' })
  @IsOptional()
  @IsValidId()
  relatedMessageId?: string;
}
