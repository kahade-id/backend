import { IsArray, ArrayMaxSize, ArrayMinSize, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { CHAT_MAX_FORWARD_TARGETS } from '../../../common/constants/app.constants';

/**
 * Forward pesan ke room lain.
 *
 * Target dibatasi: hanya room dengan lawan bicara yang SAMA yang boleh
 * menerima forward (dicek di service). Tanpa aturan itu, alamat pengiriman
 * buyer A bisa diteruskan ke seller B hanya karena kebetulan dua-duanya pernah
 * transaksi dengan user yang sama.
 */
export class ForwardMessageDto {
  @ApiProperty({
    description: 'Target chat room ids (rooms with the same counterpart only)',
    type: [String],
    maxItems: CHAT_MAX_FORWARD_TARGETS,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(CHAT_MAX_FORWARD_TARGETS)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  targetRoomIds!: string[];
}
