import { IsString, Matches, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Batch 43 BE-CHAT: POST /v1/chat/messages/:id/translate */
export class TranslateMessageDto {
  @ApiProperty({ description: 'Kode bahasa target ISO 639-1 (mis. "en", "id")', maxLength: 10 })
  @IsString()
  @MaxLength(10)
  @Matches(/^[a-z]{2}(-[A-Za-z]{2})?$/, { message: 'targetLang must be an ISO 639-1 language code (e.g. "en", "id")' })
  targetLang!: string;
}
