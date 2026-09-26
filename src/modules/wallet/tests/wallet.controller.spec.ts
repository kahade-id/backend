import { WalletController } from '../wallet.controller';

/**
 * Batch 8 (MONEY) — perbaikan spec usang: `exportCsv` kini streaming via
 * `@Res()` (Promise<void>), bukan mengembalikan { filename }.
 * Menguji nama file lewat header Content-Disposition + pemanggilan service.
 */
describe('WalletController export dates', () => {
  const walletExportService = {
    streamTransactionsCsv: jest.fn(),
  };
  const makeRes = () => ({
    set: jest.fn(),
    status: jest.fn(),
    end: jest.fn(),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-20T17:30:00.000Z'));
    walletExportService.streamTransactionsCsv.mockResolvedValue(true);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses the WIB calendar date in CSV export filenames', async () => {
    const controller = new WalletController({} as never, walletExportService as never);
    const res = makeRes();

    await controller.exportCsv('user-1', {} as never, res as never);

    // 2026-08-20T17:30Z = 2026-08-21 00:30 WIB
    expect(res.set).toHaveBeenCalledWith(
      expect.objectContaining({
        'Content-Disposition': 'attachment; filename="kahade_transactions_2026-08-21.csv"',
      }),
    );
    expect(walletExportService.streamTransactionsCsv).toHaveBeenCalledWith(
      'user-1',
      res,
      undefined,
      undefined,
      undefined,
    );
    expect(res.end).toHaveBeenCalled();
  });

  it('responds 200 when no transactions found', async () => {
    const controller = new WalletController({} as never, walletExportService as never);
    const res = makeRes();
    walletExportService.streamTransactionsCsv.mockResolvedValue(false);

    await controller.exportCsv('user-1', {} as never, res as never);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.end).toHaveBeenCalled();
  });
});
