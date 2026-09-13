import { WalletExportService } from '../export.service';

describe('WalletExportService', () => {
  const buildConfig = (maxDays: number) => ({
    get: jest.fn((key: string) => (key === 'app.exportMaxDateRangeDays' ? maxDays : undefined)),
  });

  it('uses an inclusive WIB calendar range for date-only export filters', async () => {
    const prisma = {
      wallet: { findUnique: jest.fn().mockResolvedValue({ id: 'wallet-1' }) },
      walletTransaction: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new WalletExportService(prisma as never, buildConfig(90) as never);

    await service.exportTransactionsCsv('user-1', '2026-08-21', '2026-08-21');

    expect(prisma.walletTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: {
            gte: new Date('2026-08-20T17:00:00.000Z'),
            lte: new Date('2026-08-21T16:59:59.999Z'),
          },
        }),
      }),
    );
  });

  it('rejects a range wider than the configured EXPORT_MAX_DATE_RANGE_DAYS', async () => {
    const prisma = {
      wallet: { findUnique: jest.fn() },
      walletTransaction: { findMany: jest.fn() },
    };
    const service = new WalletExportService(prisma as never, buildConfig(90) as never);

    await expect(
      service.exportTransactionsCsv('user-1', '2026-01-01', '2026-08-21'),
    ).rejects.toMatchObject({ response: { code: 'EXPORT_DATE_RANGE_TOO_LARGE' } });
  });

  it('rejects a from-only range older than the configured window (previous bypass)', async () => {
    const prisma = {
      wallet: { findUnique: jest.fn() },
      walletTransaction: { findMany: jest.fn() },
    };
    const service = new WalletExportService(prisma as never, buildConfig(90) as never);

    await expect(service.exportTransactionsCsv('user-1', '2020-01-01')).rejects.toMatchObject({
      response: { code: 'EXPORT_DATE_RANGE_TOO_LARGE' },
    });
  });

  it('rejects from after to', async () => {
    const prisma = {
      wallet: { findUnique: jest.fn() },
      walletTransaction: { findMany: jest.fn() },
    };
    const service = new WalletExportService(prisma as never, buildConfig(90) as never);

    await expect(
      service.exportTransactionsCsv('user-1', '2026-08-21', '2026-08-01'),
    ).rejects.toMatchObject({ response: { code: 'EXPORT_INVALID_DATE_RANGE' } });
  });
});
