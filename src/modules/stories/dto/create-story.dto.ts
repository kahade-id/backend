import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsDefined,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const STORY_KINDS = ['image', 'video', 'text'] as const;

export class StoryProductTagInputDto {
  @ApiProperty({ maxLength: 100 })
  @IsString()
  @MaxLength(100)
  productId!: string;

  @ApiProperty({ minimum: 0, maximum: 1 })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  x!: number;

  @ApiProperty({ minimum: 0, maximum: 1 })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  y!: number;
}

export class StoryAudienceDto {
  @ApiProperty({ enum: ['all_savers', 'savers_except'] })
  @IsIn(['all_savers', 'savers_except'])
  mode!: 'all_savers' | 'savers_except';

  @ApiPropertyOptional({ type: [String], maxItems: 500 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  excludedUserIds?: string[];
}

export class StoryPriceStickerDto {
  @ApiProperty({ minimum: 1, maximum: 999999999 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(999999999)
  amount!: number;
}

export class StoryAskStockDto {
  @ApiPropertyOptional({ nullable: true, maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  productId?: string | null;
}

export class CreateStoryDto {
  @ApiProperty({ enum: STORY_KINDS })
  @IsIn(STORY_KINDS)
  kind!: 'image' | 'video' | 'text';

  @ApiPropertyOptional({
    maxLength: 100,
    description: 'Single-use mediaId returned by POST /stories/media (image or video ticket).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  mediaId?: string;

  @ApiPropertyOptional({ maxLength: 200, description: 'Story text/caption.' })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  text?: string;

  @ApiPropertyOptional({ example: '#1F2937', pattern: '^#[0-9A-Fa-f]{6}$' })
  @IsOptional()
  @IsString()
  @Matches(/^#[0-9A-Fa-f]{6}$/)
  backgroundColor?: string;

  @ApiProperty({ type: [StoryProductTagInputDto], maxItems: 5 })
  @IsDefined()
  @IsArray()
  // Service maps >5 tags to the contract error code STORY_TAGS_LIMIT. The
  // larger DTO ceiling only protects the API from pathological payloads.
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => StoryProductTagInputDto)
  productTags!: StoryProductTagInputDto[];

  @ApiPropertyOptional({ type: StoryPriceStickerDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => StoryPriceStickerDto)
  priceSticker?: StoryPriceStickerDto | null;

  @ApiPropertyOptional({ type: StoryAskStockDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => StoryAskStockDto)
  askStock?: StoryAskStockDto | null;

  @ApiProperty({ type: StoryAudienceDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => StoryAudienceDto)
  audience!: StoryAudienceDto;
}
