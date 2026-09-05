import { PrismaClient } from '@prisma/client';
import { initializeCrypto, encryptAES, hmacSHA256, decryptAES } from '../src/common/utils/crypto.util';

const prisma = new PrismaClient();

function normalizePhoneNumber(phone: string): string {
  const cleaned = phone.replace(/[\s\-\.]/g, '');
  if (cleaned.startsWith('0')) return '+62' + cleaned.slice(1);
  if (cleaned.startsWith('62') && !cleaned.startsWith('+62')) return '+' + cleaned;
  return cleaned;
}

function isEncrypted(value: string): boolean {
  return value.includes(':') && value.length > 50;
}

async function main() {
  const aesKey = process.env.AES_ENCRYPTION_KEY;
  const hmacKey = process.env.HMAC_SECRET_KEY;

  if (!aesKey || !hmacKey) {
    console.error('ERROR: AES_ENCRYPTION_KEY and HMAC_SECRET_KEY must be set');
    process.exit(1);
  }

  initializeCrypto({ aesKey, hmacSecretKey: hmacKey });

  console.log('Starting PII encryption backfill...');

  const users = await prisma.user.findMany({
    where: { phoneNumberHash: null },
    select: { id: true, phoneNumber: true, address: true },
  });

  console.log(`Found ${users.length} users without phoneNumberHash`);

  let updated = 0;
  let errors = 0;

  for (const user of users) {
    try {
      const phoneNumber = user.phoneNumber;
      if (!phoneNumber) continue;

      let plainPhone: string;
      if (isEncrypted(phoneNumber)) {
        plainPhone = await decryptAES(phoneNumber);
      } else {
        plainPhone = phoneNumber;
      }

      const normalized = normalizePhoneNumber(plainPhone);
      const hash = hmacSHA256(normalized);
      const encrypted = await encryptAES(normalized);

      const updateData: Record<string, string | null> = {
        phoneNumber: encrypted,
        phoneNumberHash: hash,
      };

      if (user.address && !isEncrypted(user.address)) {
        updateData.address = await encryptAES(user.address);
      }

      await prisma.user.update({
        where: { id: user.id },
        data: updateData,
      });

      updated++;
      if (updated % 100 === 0) console.log(`  Processed ${updated}/${users.length}`);
    } catch (err) {
      errors++;
      console.error(`  Failed for user ${user.id}:`, (err as Error).message);
    }
  }

  console.log(`\nBackfill complete: ${updated} updated, ${errors} errors`);

  const bankAccounts = await prisma.bankAccount.findMany({
    where: { deletedAt: null },
    select: { id: true, accountName: true },
  });

  let baUpdated = 0;
  for (const ba of bankAccounts) {
    try {
      if (!ba.accountName || isEncrypted(ba.accountName)) continue;
      const encrypted = await encryptAES(ba.accountName);
      await prisma.bankAccount.update({
        where: { id: ba.id },
        data: { accountName: encrypted },
      });
      baUpdated++;
    } catch (err) {
      console.error(`  Failed for bank account ${ba.id}:`, (err as Error).message);
    }
  }

  console.log(`Bank account names encrypted: ${baUpdated}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
