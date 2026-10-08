import { IsArray, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const STORY_REACTION_EMOJIS = ['❤️', '😂', '😮', '😢', '👏', '🔥'] as const;
export type StoryReactionEmoji = (typeof STORY_REACTION_EMOJIS)[number];

export class SetStoryReactionDto {
  @ApiProperty({ enum: STORY_REACTION_EMOJIS })
  @IsString()
  emoji!: string;
}

export class ReplyToStoryDto {
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  text!: string;
}

export class ReportStoryDto {
  @ApiProperty({ enum: ['spam', 'harassment', 'offensive', 'irrelevant', 'other'] })
  @IsIn(['spam', 'harassment', 'offensive', 'irrelevant', 'other'])
  category!: 'spam' | 'harassment' | 'offensive' | 'irrelevant' | 'other';

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(500)
  note?: string;
}

export class CreateStoryHighlightDto {
  @ApiProperty({ maxLength: 24 })
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  title!: string;

  @ApiProperty({ type: [String], minItems: 1, maxItems: 30 })
  @IsArray()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  storyIds!: string[];
}

export class UpdateStoryHighlightDto {
  @ApiPropertyOptional({ maxLength: 24 })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  title?: string;

  @ApiPropertyOptional({ type: [String], minItems: 1, maxItems: 30 })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  storyIds?: string[];
}
