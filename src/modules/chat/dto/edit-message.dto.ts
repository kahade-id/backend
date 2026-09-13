import { IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { CHAT_MESSAGE_MAX_LENGTH } from '../../../common/constants/app.constants';

/**
 * Edit pesan teks.
 *
 * Riwayat revisi disimpan di `ChatMessageEdit` sebelum konten baru ditulis,
 * sehingga edit tidak pernah menjadi cara menghapus bukti percakapan secara
 * diam-diam (penting saat order berstatus DISPUTED).
 */
export class EditMessageDto {
  @ApiProperty({ description: 'New message content', maxLength: CHAT_MESSAGE_MAX_LENGTH })
  @IsString()
  @MaxLength(CHAT_MESSAGE_MAX_LENGTH)
  content!: string;
}
