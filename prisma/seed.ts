import { PrismaClient, KycStatus, UserAccountType, AdminRole, VoucherType } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { initializeCrypto } from '../src/common/utils/crypto.util';
import { encryptPii, hashPhoneNumber, normalizePhoneNumber } from '../src/common/utils/pii.util';

const prisma = new PrismaClient();

const BCRYPT_ROUNDS = 12;
const TEST_PASSWORD = process.env.SEED_PASSWORD || 'TestPassword123!';

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SEED ABORTED: Never run seeds in production. Set NODE_ENV to development or staging.');
  }

  const aesSecretKey = process.env.PII_ENCRYPTION_KEY ?? process.env.AES_SECRET_KEY;
  const hmacSecretKey = process.env.HMAC_SECRET_KEY ?? process.env.PII_HMAC_KEY;
  if (!aesSecretKey || !hmacSecretKey) {
    throw new Error(
      'SEED ABORTED: PII_ENCRYPTION_KEY and HMAC_SECRET_KEY env vars are required to encrypt seeded phone numbers.',
    );
  }
  initializeCrypto({
    aesSecretKey,
    aesKdfSalt: process.env.AES_KDF_SALT,
    hmacSecretKey,
  });

  async function buildPhoneFields(rawPhone: string): Promise<{ phoneNumber: string; phoneNumberHash: string }> {
    const normalized = normalizePhoneNumber(rawPhone);
    return {
      phoneNumber: await encryptPii(normalized),
      phoneNumberHash: hashPhoneNumber(normalized),
    };
  }

  console.log('⚠️  Seeding Kahade development database...');
  console.log('    All test accounts use a shared development-only password.');
  console.log('    DO NOT run this seed against staging or production.\n');

  // ── 1. Admin superuser ────────────────────────────────────────────
  const adminEmail = 'admin@kahade.id';
  const existingAdmin = await prisma.adminUser.findUnique({ where: { email: adminEmail } });
  if (!existingAdmin) {
    const hashedPw = await bcrypt.hash(TEST_PASSWORD, BCRYPT_ROUNDS);
    await prisma.adminUser.create({
      data: {
        // Format: ADMIN-XXXXX
        adminId: `ADMIN-${Date.now().toString().slice(-5)}`,
        email: adminEmail,
        password: hashedPw,
        fullName: 'Kahade Admin',
        role: AdminRole.SUPER_ADMIN,
        isActive: true,
      },
    });
    console.log('✓ Admin created: admin@kahade.id (SUPER_ADMIN)');
  } else {
    console.log('- Admin already exists, skipping.');
  }

  // ── 2. Test Buyer (KYC APPROVED) ──────────────────────────────────
  const buyerEmail = 'buyer@test.kahade.id';
  let buyer = await prisma.user.findUnique({ where: { email: buyerEmail } });
  if (!buyer) {
    const hashedPw = await bcrypt.hash(TEST_PASSWORD, BCRYPT_ROUNDS);
    const buyerPhone = await buildPhoneFields('081200000001');
    buyer = await prisma.user.create({
      data: {
        userId: 'USR-TEST-BUYER01',
        email: buyerEmail,
        password: hashedPw,
        fullName: 'Test Buyer',
        username: 'testbuyer',
        ...buyerPhone,
        phoneVerified: true,
        emailVerified: true,
        emailVerifiedAt: new Date(),
        kycStatus: KycStatus.APPROVED,
        kycApprovedAt: new Date(),

        accountType: UserAccountType.PERSONAL,
        wallet: { create: {} },
        notificationPreference: { create: {} },
        referralCode: { create: { code: 'BUYERREF1' } },
      },
    });
    console.log('✓ Buyer created: buyer@test.kahade.id (KYC APPROVED)');
  } else {
    console.log('- Buyer already exists, skipping.');
  }

  // ── 3. Test Seller (KYC APPROVED) ─────────────────────────────────
  const sellerEmail = 'seller@test.kahade.id';
  let seller = await prisma.user.findUnique({ where: { email: sellerEmail } });
  if (!seller) {
    const hashedPw = await bcrypt.hash(TEST_PASSWORD, BCRYPT_ROUNDS);
    const sellerPhone = await buildPhoneFields('081200000002');
    seller = await prisma.user.create({
      data: {
        userId: 'USR-TEST-SELLR1',
        email: sellerEmail,
        password: hashedPw,
        fullName: 'Test Seller',
        username: 'testseller',
        ...sellerPhone,
        phoneVerified: true,
        emailVerified: true,
        emailVerifiedAt: new Date(),
        kycStatus: KycStatus.APPROVED,
        kycApprovedAt: new Date(),

        accountType: UserAccountType.BUSINESS,
        wallet: { create: {} },
        notificationPreference: { create: {} },
        referralCode: { create: { code: 'SELLERREF1' } },
      },
    });
    console.log('✓ Seller created: seller@test.kahade.id (KYC APPROVED)');
  } else {
    console.log('- Seller already exists, skipping.');
  }

  // ── 4. Sample voucher ─────────────────────────────────────────────
  const voucherCode = 'DEVTEST50';
  const existingVoucher = await prisma.voucher.findUnique({ where: { code: voucherCode } });
  if (!existingVoucher) {
    await prisma.voucher.create({
      data: {
        voucherId: 'VCH-DEVTEST-001',
        code: voucherCode,
        
        name: 'Dev Test 50% Fee Discount',
        description: 'Dev test voucher — 50% fee discount',
        voucherType: VoucherType.FEE_DISCOUNT_PERCENT,
        discountPercent: 50,
        
        maxUsageTotal: 100,      // was: maxUses
        currentUsage: 0,         // was: currentUses
        minOrderValue: BigInt(10000),
        validFrom: new Date(),   // was: startDate
        validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // was: endDate
        isActive: true,
        
        createdBy: 'ADMIN-00001',
      },
    });
    console.log('✓ Voucher created: DEVTEST50 (50% fee discount, 1 year validity)');
  } else {
    console.log('- Voucher already exists, skipping.');
  }

  console.log('\n✅ Seed complete.');
  console.log(`   Credentials for all test accounts: [set via SEED_PASSWORD env var]`);
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
