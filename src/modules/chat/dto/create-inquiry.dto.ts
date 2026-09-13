import { IsString, MaxLength, IsOptional, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  CHAT_INQUIRY_SUBJECT_MAX_LENGTH,
  CHAT_INQUIRY_FIRST_MESSAGE_MAX_LENGTH,
} from '../../../common/constants/app.constants';

/**
 * Membuka percakapan pra-transaksi (nego sebelum buyer membuat order dan dana
 * dikunci di escrow).
 *
 * Sebelum fitur ini, chat hanya bisa ada setelah order dibuat
 * (`ChatRoom.orderId` NOT NULL), sehingga buyer yang masih ragu tidak punya
 * tempat bertanya tanpa langsung commit.
 */
export class CreateInquiryDto {
  @ApiProperty({ description: 'User id of the counterpart to negotiate with' })
  @IsString()
  @MaxLength(100)
  counterpartId!: string;

  @ApiPropertyOptional({
    description: 'What the inquiry is about (e.g. item title). Shown as the conversation header.',
    maxLength: CHAT_INQUIRY_SUBJECT_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(CHAT_INQUIRY_SUBJECT_MAX_LENGTH)
  subject?: string;

  @ApiProperty({
    description: 'First message',
    maxLength: CHAT_INQUIRY_FIRST_MESSAGE_MAX_LENGTH,
  })
  @IsString()
  @MaxLength(CHAT_INQUIRY_FIRST_MESSAGE_MAX_LENGTH)
  @Matches(/\S/, { message: 'message must not be empty' })
  message!: string;
}
