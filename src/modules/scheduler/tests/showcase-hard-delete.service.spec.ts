/**
 * Audit Batch 5 — SS-013/SS-014: hard delete etalase.
 *
 * - SS-013: scheduler mengulang batch (tidak berhenti di 500 pertama).
 * - SS-014: storage dibersihkan DULU; kegagalan cleanup menahan hapus DB
 *   (baris dipertahankan untuk retry), bukan di-silent-catch.
 */
jest.mock('../../../common/utils/cron-jitter.util', () => ({
  cronJitter: jest.fn().mockResolvedValue(undefined),
}));

import { ShowcaseHardDeleteService } from '../services/showcase-hard-delete.service';

function expiredItem(id: string, fileKeys: string[] = ['k1']) {
  return {
    id,
    userId: 'owner-5',
    images: fileKeys.map((fileKey) => ({ fileKey })),
  };
}

describe('ShowcaseHardDeleteService — audit Batch 5', () => {
  const prisma = {
    userShowcase: { findMany: jest.fn(), delete: jest.fn() },
  };
  const redis = {
    isHealthy: jest.fn(),
    setNx: jest.fn(),
    get: jest.fn(),
    expire: jest.fn(),
    renewLock: jest.fn(),
    releaseLock: jest.fn(),
  };
  const uploadService = { cleanupFileKeys: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    redis.isHealthy.mockResolvedValue(true);
    redis.setNx.mockResolvedValue(true);
    redis.get.mockImplementation(async () => redis.setNx.mock.calls[0]?.[1]);
    redis.renewLock.mockResolvedValue(true);
    redis.releaseLock.mockResolvedValue(true);
    uploadService.cleanupFileKeys.mockResolvedValue({ deleted: 1, errors: [] });
    prisma.userShowcase.delete.mockResolvedValue({ id: 'x' });
  });

  function makeService() {
    return new ShowcaseHardDeleteService(prisma as never, redis as never, uploadService as never);
  }

  it('SS-013: memproses batch berikutnya sampai tidak ada lagi item kedaluwarsa', async () => {
    // Batch 1: 500 item, batch 2: 250 item, batch 3: kosong → selesai.
    const batch1 = Array.from({ length: 500 }, (_, i) => expiredItem(`item-${i}`));
    const batch2 = Array.from({ length: 250 }, (_, i) => expiredItem(`item-b-${i}`));
    prisma.userShowcase.findMany
      .mockResolvedValueOnce(batch1)
      .mockResolvedValueOnce(batch2)
      .mockResolvedValueOnce([]);

    await makeService().hardDeleteExpiredShowcases();

    expect(prisma.userShowcase.findMany).toHaveBeenCalledTimes(3);
    expect(prisma.userShowcase.findMany.mock.calls[0][0].take).toBe(500);
    expect(prisma.userShowcase.delete).toHaveBeenCalledTimes(750);
  });

  it('SS-014: kegagalan cleanup storage MENAHAN hapus DB (retryable)', async () => {
    prisma.userShowcase.findMany
      .mockResolvedValueOnce([expiredItem('item-ok'), expiredItem('item-fail')])
      .mockResolvedValueOnce([]);
    uploadService.cleanupFileKeys
      .mockResolvedValueOnce({ deleted: 1, errors: [] })
      .mockResolvedValueOnce({ deleted: 0, errors: [{ fileKey: 'k1', reason: 'disk penuh' }] });

    await makeService().hardDeleteExpiredShowcases();

    // Hanya item-ok yang dihapus dari DB; item-fail dipertahankan.
    expect(prisma.userShowcase.delete).toHaveBeenCalledTimes(1);
    expect(prisma.userShowcase.delete).toHaveBeenCalledWith({ where: { id: 'item-ok' } });
    expect(prisma.userShowcase.delete).not.toHaveBeenCalledWith({ where: { id: 'item-fail' } });
  });

  it('SS-014: item sukses dibersihkan DULU di storage baru dihapus dari DB', async () => {
    prisma.userShowcase.findMany
      .mockResolvedValueOnce([expiredItem('item-1', ['a', 'b'])])
      .mockResolvedValueOnce([]);

    const order: string[] = [];
    uploadService.cleanupFileKeys.mockImplementation(async () => {
      order.push('storage');
      return { deleted: 2, errors: [] };
    });
    prisma.userShowcase.delete.mockImplementation(async () => {
      order.push('db');
      return { id: 'item-1' };
    });

    await makeService().hardDeleteExpiredShowcases();

    expect(order).toEqual(['storage', 'db']);
    expect(uploadService.cleanupFileKeys).toHaveBeenCalledWith('owner-5', ['a', 'b']);
  });

  it('tidak memproses apa pun bila Redis tidak sehat', async () => {
    redis.isHealthy.mockResolvedValue(false);

    await makeService().hardDeleteExpiredShowcases();

    expect(prisma.userShowcase.findMany).not.toHaveBeenCalled();
  });
});
