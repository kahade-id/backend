import { IsString, Matches, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { CHAT_MAX_EMOJI_LENGTH } from '../../../common/constants/app.constants';

/**
 * Reaksi emoji pada pesan.
 *
 * Validasi sengaja longgar pada *karakter* (emoji terus bertambah di Unicode)
 * tapi ketat pada hal yang bisa disalahgunakan: panjang, spasi, dan karakter
 * kontrol. Panjang dihitung dalam code point, bukan UTF-16 unit, supaya emoji
 * di luar BMP tidak terhitung dua.
 */
export class AddReactionDto {
  @ApiProperty({
    description: 'Emoji to react with (1–8 code points)',
    example: '👍',
    maxLength: CHAT_MAX_EMOJI_LENGTH,
  })
  @IsString()
  @MaxLength(CHAT_MAX_EMOJI_LENGTH)
  @Matches(/^[\p{Extended_Pictographic}\p{Emoji_Component}0-9#*]+$/u, {
    message: 'emoji must contain only emoji characters',
  })
  emoji!: string;
}
