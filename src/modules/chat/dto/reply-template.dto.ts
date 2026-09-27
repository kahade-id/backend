import { IsString, IsOptional, Matches, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Batch 43 BE-CHAT: template balasan cepat "/" (per user, sinkron antar device). */
export class CreateReplyTemplateDto {
  @ApiProperty({ description: 'Shortcut tanpa "/" (mis. "salam" untuk "/salam")', maxLength: 32 })
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  @Matches(/^[a-z0-9_]+$/, { message: 'shortcut may only contain lowercase letters, numbers, and underscores' })
  shortcut!: string;

  @ApiProperty({ description: 'Isi template balasan', maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  text!: string;
}

export class UpdateReplyTemplateDto {
  @ApiPropertyOptional({ description: 'Shortcut tanpa "/"', maxLength: 32 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  @Matches(/^[a-z0-9_]+$/, { message: 'shortcut may only contain lowercase letters, numbers, and underscores' })
  shortcut?: string;

  @ApiPropertyOptional({ description: 'Isi template balasan', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  text?: string;
}
