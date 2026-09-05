import { WalletExportService } from '../export.service';

describe('WalletExportService', () => {
  it('uses an inclusive WIB calendar range for date-only export filters', async () => {
    const prisma = {
      wallet: { findUnique: jest.fn().mockResolvedValue({ id: 'wallet-1' }) },
      walletTransaction: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new WalletExportService(prisma as never);

    await service.exportTransactionsCsv('user-1', '2026-08-21', '2026-08-21');

    expect(prisma.walletTransaction.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        createdAt: {
          gte: new Date('2026-08-20T17:00:00.000Z'),
          lte: new Date('2026-08-21T16:59:59.999Z'),
        },
      }),
    }));
  });
});
