import { PrismaClient } from '@prisma/client';
import { initializeCrypto } from '../src/common/utils/crypto.util';
import {
  blindChatLocation,
  isBlindedLocation,
  BLINDED_LOCATION_THRESHOLD,
} from '../src/modules/chat/utils/chat-location-crypto';

/**
 * SEC-D (ronde 2) — backfill blinding koordinat lokasi pesan chat.
 *
 * Latar: pesan LOCATION (batch 43 BE-CHAT) menyimpan locationLat/Lng
 * plaintext di DB. Sejak fix ini, ChatService menulis koordinat ter-blinding
 * (keyed, per-messageId). Skrip ini mem-blind semua baris lama.
 *
 * IDEMPOTEN — aman di-rerun: baris yang sudah ter-blinding (lat & lng >
 * BLINDED_LOCATION_THRESHOLD = 900) dilewati. Tidak ada DDL (kolom tetap
 * Float; blinding muat di double) — sesuai aturan additive-only misi ini.
 *
 * Dijalankan koordinator di production dengan env:
 *   DATABASE_URL, HMAC_SECRET_KEY (AES_SECRET_KEY boleh kosong untuk skrip ini)
 * Catatan: .env produksi tidak bisa di-source langsung (quote tak tertutup)
 * — export via parser python line-split sebelum menjalankan.
 *
 *   npm run backfill:encrypt-locations
 */

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const hmacKey = process.env.HMAC_SECRET_KEY;
  if (!hmacKey) {
    console.error('ERROR: HMAC_SECRET_KEY harus di-set');
    process.exit(1);
  }
  // blindChatLocation hanya butuh HMAC; AES key boleh dummy.
  initializeCrypto({
    aesSecretKey: process.env.AES_SECRET_KEY ?? 'unused-by-location-backfill',
    hmacSecretKey: hmacKey,
    kycNikEncryptionKey: process.env.KYC_NIK_ENCRYPTION_KEY,
    kycKtpEncryptionKey: process.env.KYC_KTP_ENCRYPTION_KEY,
    kycSelfieEncryptionKey: process.env.KYC_SELFIE_ENCRYPTION_KEY,
  });

  const BATCH = 200;
  let cursor: string | undefined;
  let scanned = 0;
  let blinded = 0;
  let skipped = 0;

  for (;;) {
    const rows = await prisma.chatMessage.findMany({
      where: { messageType: 'LOCATION', locationLat: { not: null }, locationLng: { not: null } },
      take: BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
      select: { id: true, locationLat: true, locationLng: true },
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      scanned++;
      const lat = row.locationLat;
      const lng = row.locationLng;
      if (lat == null || lng == null) {
        skipped++;
        continue;
      }
      if (isBlindedLocation(lat, lng)) {
        skipped++;
        continue;
      }
      // Guard: jangan blind nilai yang bukan koordinat valid (data anomali).
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        console.warn(`Lewati ${row.id}: koordinat di luar rentang valid (lat=${lat}, lng=${lng})`);
        skipped++;
        continue;
      }
      const b = blindChatLocation(lat, lng, row.id);
      await prisma.chatMessage.update({
        where: { id: row.id },
        data: { locationLat: b.lat, locationLng: b.lng },
      });
      blinded++;
    }
    cursor = rows[rows.length - 1].id;
    console.log(
      `progres: ${scanned} dipindai (${blinded} di-blinding, ${skipped} dilewati) ` +
        `(ambang blind=${BLINDED_LOCATION_THRESHOLD})`,
    );
  }

  console.log(`SELESAI: ${scanned} baris, ${blinded} di-blinding, ${skipped} dilewati`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('Backfill gagal:', e);
  process.exit(1);
});
