import { IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export const SUPPORTED_LANGUAGES = ['id', 'en'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export class UpdateLanguageDto {
  @ApiProperty({ description: 'Language code', enum: SUPPORTED_LANGUAGES, example: 'id' })
  @IsIn(SUPPORTED_LANGUAGES, { message: `language must be one of: ${SUPPORTED_LANGUAGES.join(', ')}` })
  language!: SupportedLanguage;
}
