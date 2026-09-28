import { PrismaClient } from '@prisma/client';
import { initializeCrypto, encryptAES } from '../src/common/utils/crypto.util';

/**
 * H2 (SEC-D ronde 2) — backfill enkripsi PII buku alamat.
 *
 * 1. DDL idempoten: kolom PII addresses (recipientName, phone, addressLine,
 *    city, province, postalCode) diubah dari VarChar(n) → TEXT agar muat
 *    ciphertext AES-GCM (`v1:salt:iv:tag:data`). Dijalankan via raw SQL di
 *    sini (BUKAN migrasi Prisma — sesuai aturan additive-only misi ini).
 *    Prisma schema.prisma sudah diselaraskan ke @db.Text.
 * 2. Enkripsi semua baris yang field PII-nya masih plaintext. Deteksi via
 *    prefix `v1:` (format crypto.util). IDEMPOTEN — aman di-rerun: baris yang
 *    sudah terenkripsi dilewati.
 *
 * Dijalankan koordinator di production dengan env:
 *   DATABASE_URL, AES_SECRET_KEY (atau PII_ENCRYPTION_KEY), HMAC_SECRET_KEY
 * Catatan: .env produksi tidak bisa di-source langsung (quote tak tertutup)
 * — export via parser python line-split sebelum menjalankan.
 *
 *   npm run backfill:encrypt-addresses
 */

const prisma = new PrismaClient();

const PII_COLUMNS = ['recipientName', 'phone', 'addressLine', 'city', 'province', 'postalCode'] as const;

function isEncrypted(value: string | null): boolean {
  return !!value && value.startsWith('v1:');
}

async function ensureTextColumns(): Promise<void> {
  for (const col of PII_COLUMNS) {
    const rows = await prisma.$queryRaw<Array<{ character_maximum_length: number | null }>>`
      SELECT character_maximum_length
      FROM information_schema.columns
      WHERE table_name = 'addresses' AND column_name = ${col}
    `;
    const maxLen = rows[0]?.character_maximum_length ?? null;
    if (maxLen !== null) {
      console.log(`ALTER addresses.${col}: varchar(${maxLen}) → text`);
      await prisma.$executeRawUnsafe(`ALTER TABLE "addresses" ALTER COLUMN "${col}" TYPE TEXT`);
    } else {
      console.log(`addresses.${col} sudah text — lewati`);
    }
  }
}

async function main(): Promise<void> {
  const aesKey = process.env.PII_ENCRYPTION_KEY ?? process.env.AES_SECRET_KEY;
  const hmacKey = process.env.HMAC_SECRET_KEY;
  if (!aesKey || !hmacKey) {
    console.error('ERROR: AES_SECRET_KEY (atau PII_ENCRYPTION_KEY) dan HMAC_SECRET_KEY harus di-set');
    process.exit(1);
  }
  initializeCrypto({ aesSecretKey: aesKey, hmacSecretKey: hmacKey });

  await ensureTextColumns();

  const BATCH = 200;
  let cursor: string | undefined;
  let scanned = 0;
  let encrypted = 0;
  let skipped = 0;

  for (;;) {
    const rows = await prisma.address.findMany({
      take: BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
      select: {
        id: true,
        recipientName: true,
        phone: true,
        addressLine: true,
        city: true,
        province: true,
        postalCode: true,
      },
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      scanned++;
      const data: Record<string, string | null> = {};
      for (const col of PII_COLUMNS) {
        const v = row[col] as string | null;
        if (v !== null && !isEncrypted(v)) {
          data[col] = await encryptAES(v);
        }
      }
      if (Object.keys(data).length > 0) {
        await prisma.address.update({ where: { id: row.id }, data });
        encrypted++;
      } else {
        skipped++;
      }
    }
    cursor = rows[rows.length - 1].id;
    console.log(`progres: ${scanned} baris dipindai (${encrypted} dienkripsi, ${skipped} sudah terenkripsi)`);
  }

  console.log(`SELESAI: ${scanned} baris, ${encrypted} dienkripsi, ${skipped} dilewati (sudah terenkripsi)`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('Backfill gagal:', e);
  process.exit(1);
});
