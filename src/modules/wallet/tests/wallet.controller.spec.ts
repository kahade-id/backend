import { WalletController } from '../wallet.controller';

describe('WalletController export dates', () => {
  const walletExportService = {
    exportTransactionsCsv: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-20T17:30:00.000Z'));
    walletExportService.exportTransactionsCsv.mockResolvedValue('Tanggal,Nominal\n');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses the WIB calendar date in CSV export filenames', async () => {
    const controller = new WalletController({} as never, walletExportService as never);

    const result = await controller.exportCsv('user-1', {} as never);

    expect(result.filename).toBe('kahade_transactions_2026-08-21.csv');
  });
});
