import { IsString, IsOptional, IsBoolean, IsArray, IsInt, Min, Max, MaxLength, ArrayMinSize, ArrayMaxSize } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  CHAT_POLL_MIN_OPTIONS,
  CHAT_POLL_MAX_OPTIONS,
  CHAT_POLL_QUESTION_MAX_LENGTH,
} from '../../../common/constants/app.constants';

/** Batch 43 BE-CHAT: POST /v1/chat/rooms/:roomId/polls */
export class CreatePollDto {
  @ApiProperty({ description: 'Pertanyaan polling', maxLength: CHAT_POLL_QUESTION_MAX_LENGTH })
  @IsString()
  @MaxLength(CHAT_POLL_QUESTION_MAX_LENGTH)
  question!: string;

  @ApiProperty({ description: 'Opsi jawaban (2–10)', type: [String] })
  @IsArray()
  @ArrayMinSize(CHAT_POLL_MIN_OPTIONS, { message: `Poll must have at least ${CHAT_POLL_MIN_OPTIONS} options` })
  @ArrayMaxSize(CHAT_POLL_MAX_OPTIONS, { message: `Poll can have at most ${CHAT_POLL_MAX_OPTIONS} options` })
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  options!: string[];

  @ApiPropertyOptional({ description: 'Boleh pilih lebih dari satu opsi', default: false })
  @IsOptional()
  @IsBoolean()
  allowMultiple?: boolean;

  @ApiPropertyOptional({ description: 'Batas waktu voting (ISO 8601)' })
  @IsOptional()
  @IsString()
  deadline?: string;
}

/** Batch 43 BE-CHAT: POST /v1/chat/rooms/:roomId/polls/:pollId/vote */
export class VotePollDto {
  @ApiProperty({ description: 'Indeks opsi yang dipilih (0-based)', type: [Number] })
  @IsArray()
  @ArrayMinSize(1, { message: 'At least one option must be selected' })
  @ArrayMaxSize(CHAT_POLL_MAX_OPTIONS)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(CHAT_POLL_MAX_OPTIONS - 1, { each: true })
  optionIndexes!: number[];
}
