import { registerAs } from '@nestjs/config';

export type ChatCircumventionAction = 'BLOCKED' | 'REDACTED' | 'FLAGGED';

/**
 * Konfigurasi Trust & Safety chat.
 *
 * `circumventionAction` adalah saklar utama: seberapa keras chat menolak ajakan
 * transaksi di luar aplikasi. Nilai default BLOCKED karena transaksi di luar
 * escrow menghilangkan proteksi yang menjadi inti produk Kahade. Operator bisa
 * menurunkannya ke REDACTED (sensor pola kontak, pesan tetap terkirim) atau
 * FLAGGED (hanya catat & tinjau) lewat env tanpa deploy ulang — berguna bila
 * suatu saat false positive melonjak dan kita ingin tetap menerima pesan
 * sembari mengevaluasi ulang detektornya.
 */
function parseAction(raw: string | undefined): ChatCircumventionAction {
  const normalized = (raw ?? '').trim().toUpperCase();
  if (normalized === 'REDACTED' || normalized === 'FLAGGED') return normalized;
  return 'BLOCKED';
}

export const chatConfig = registerAs('chat', () => ({
  circumventionAction: parseAction(process.env.CHAT_CIRCUMVENTION_ACTION),
}));
