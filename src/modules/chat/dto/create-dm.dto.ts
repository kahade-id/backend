import { IsString, MaxLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Membuka (atau memakai ulang) room DM dengan user lain — tanpa pesan pertama.
 * Dipakai tombol "Kirim Pesan" di profil (perilaku seperti WhatsApp): pengguna
 * langsung masuk ke halaman chat walaupun belum pernah chat sebelumnya.
 *
 * Memakai username publik (bukan id internal) supaya client tidak perlu
 * menebak namespace id.
 */
export class CreateDmDto {
  @ApiProperty({ description: 'Username publik lawan bicara', maxLength: 30 })
  @IsString()
  @MaxLength(30)
  @Matches(/^[a-zA-Z0-9_.-]{3,30}$/, { message: 'Invalid username format' })
  username!: string;
}
