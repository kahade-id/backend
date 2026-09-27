import { AdminReferralService } from './admin-referral.service';

/**
 * ADM-221 — pencarian kode referral server-side (`q`).
 * Membuktikan:
 *  1. `q` kosong/blank → tidak ada filter OR (perilaku lama).
 *  2. `q` terisi → OR atas code / username / fullName pemilik (insensitive).
 *  3. Filter isActive tetap digabung dengan q.
 */
describe('AdminReferralService.listReferralCodes search (ADM-221)', () => {
  const prisma = {
    referralCode: { findMany: jest.fn(async () => []), count: jest.fn(async () => 0) },
  };
  const service = () => new AdminReferralService(prisma as never);

  const lastWhere = (): Record<string, unknown> => {
    const calls = prisma.referralCode.findMany.mock.calls as unknown[][];
    const call = calls[0];
    if (!call || call[0] == null) throw new Error('findMany tidak dipanggil');
    return (call[0] as { where: Record<string, unknown> }).where;
  };

  beforeEach(() => jest.clearAllMocks());

  it('tanpa q: where tanpa OR', async () => {
    await service().listReferralCodes(1, 20, undefined, undefined);
    const where = lastWhere();
    expect(where.OR).toBeUndefined();
  });

  it('q blank: where tanpa OR', async () => {
    await service().listReferralCodes(1, 20, undefined, '   ');
    const where = lastWhere();
    expect(where.OR).toBeUndefined();
  });

  it('q terisi: OR code/username/fullName insensitive', async () => {
    await service().listReferralCodes(1, 20, undefined, 'budi');
    const where = lastWhere();
    expect(where.OR).toEqual([
      { code: { contains: 'budi', mode: 'insensitive' } },
      { user: { username: { contains: 'budi', mode: 'insensitive' } } },
      { user: { fullName: { contains: 'budi', mode: 'insensitive' } } },
    ]);
    // count memakai filter yang sama
    expect(prisma.referralCode.count).toHaveBeenCalledWith({ where });
  });

  it('q digabung dengan filter isActive', async () => {
    await service().listReferralCodes(1, 20, 'true', 'KHD');
    const where = lastWhere();
    expect(where.isActive).toBe(true);
    expect(where.OR).toHaveLength(3);
  });
});
