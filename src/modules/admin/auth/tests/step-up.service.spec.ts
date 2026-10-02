import { ForbiddenException } from '@nestjs/common';
import { AdminStepUpService } from '../step-up.service';
import * as ErrorCodes from '../../../../common/constants/error-codes';

/**
 * SEC-503: step-up token WAJIB single-use — pemakaian kedua dengan token
 * yang sama DITOLAK 403 (bahkan bila pemakaian pertama berhasil).
 */
describe('AdminStepUpService single-use (SEC-503)', () => {
  // Simulasi tabel AdminStepUpToken di memori (tokenHash → record).
  const store = new Map<
    string,
    { tokenHash: string; adminId: string; action: string; targetId: string | null; expiresAt: Date; usedAt: Date | null }
  >();

  const prisma = {
    adminStepUpToken: {
      findUnique: jest.fn(async ({ where }: { where: { tokenHash: string } }) => {
        return store.get(where.tokenHash) ?? null;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: { tokenHash: string; usedAt: null }; data: { usedAt: Date } }) => {
        const rec = store.get(where.tokenHash);
        if (!rec || rec.usedAt !== null) return { count: 0 };
        rec.usedAt = data.usedAt;
        return { count: 1 };
      }),
    },
  };
  const auditLog = { logAdminAction: jest.fn() };
  const service = new AdminStepUpService(prisma as never, auditLog as never);

  const RAW_TOKEN = 'token-mentah-untuk-uji-single-use-001';
  const ADMIN_ID = 'admin-1';

  beforeEach(() => {
    store.clear();
    jest.clearAllMocks();
    // Simulasi token yang sudah diterbitkan (issueStepUpToken).
    store.set(AdminStepUpService.hashToken(RAW_TOKEN), {
      tokenHash: AdminStepUpService.hashToken(RAW_TOKEN),
      adminId: ADMIN_ID,
      action: 'wallet.adjust',
      targetId: 'user-123',
      expiresAt: new Date(Date.now() + 3 * 60 * 1000),
      usedAt: null,
    });
  });

  function codeOf(err: unknown): unknown {
    const res = (err as ForbiddenException).getResponse() as { code?: unknown };
    return res.code;
  }

  it('pemakaian pertama berhasil (tidak melempar)', async () => {
    await expect(
      service.consumeStepUpToken(RAW_TOKEN, { adminId: ADMIN_ID, action: 'wallet.adjust', targetId: 'user-123' }),
    ).resolves.toBeUndefined();
  });

  it('pemakaian kedua dengan token yang sama → 403 STEP_UP_INVALID', async () => {
    await service.consumeStepUpToken(RAW_TOKEN, { adminId: ADMIN_ID, action: 'wallet.adjust', targetId: 'user-123' });
    await expect(
      service.consumeStepUpToken(RAW_TOKEN, { adminId: ADMIN_ID, action: 'wallet.adjust', targetId: 'user-123' }),
    ).rejects.toMatchObject({ status: 403 });
    try {
      await service.consumeStepUpToken(RAW_TOKEN, { adminId: ADMIN_ID, action: 'wallet.adjust', targetId: 'user-123' });
      fail('seharusnya melempar');
    } catch (err) {
      expect(codeOf(err)).toBe(ErrorCodes.STEP_UP_INVALID);
    }
  });

  it('tanpa token → 403 STEP_UP_REQUIRED', async () => {
    try {
      await service.consumeStepUpToken(undefined, { adminId: ADMIN_ID, action: 'wallet.adjust' });
      fail('seharusnya melempar');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(codeOf(err)).toBe(ErrorCodes.STEP_UP_REQUIRED);
    }
  });

  it('aksi berbeda → 403 STEP_UP_MISMATCH (token tidak hangus oleh percobaan gagal)', async () => {
    try {
      await service.consumeStepUpToken(RAW_TOKEN, { adminId: ADMIN_ID, action: 'dispute.resolve' });
      fail('seharusnya melempar');
    } catch (err) {
      expect(codeOf(err)).toBe(ErrorCodes.STEP_UP_MISMATCH);
    }
    // Token masih bisa dipakai untuk aksi yang benar (belum hangus).
    await expect(
      service.consumeStepUpToken(RAW_TOKEN, { adminId: ADMIN_ID, action: 'wallet.adjust', targetId: 'user-123' }),
    ).resolves.toBeUndefined();
  });
});
