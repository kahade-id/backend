import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { MidtransService } from './midtrans.service';

describe('MidtransService Iris payout logging', () => {
  const configService = {
    get: jest.fn((key: string) => {
      if (key === 'midtrans.irisKey') return 'test-iris-key';
      if (key === 'midtrans.irisIsProduction') return false;
      return undefined;
    }),
  };

  beforeEach(() => {
    jest.restoreAllMocks();
    configService.get.mockClear();
  });

  it('does not log sensitive beneficiary data returned by a rejected Iris payout', async () => {
    const logError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 422,
      text: async () =>
        JSON.stringify({
          payouts: [
            { beneficiary_account: '081234567890', beneficiary_name: 'Sensitive Recipient' },
          ],
        }),
    } as Response);
    const service = new MidtransService(configService as never);

    await expect(
      service.createIrisPayout({
        referenceNo: 'WLT-20260820-000001',
        beneficiaryName: 'Sensitive Recipient',
        beneficiaryAccount: '081234567890',
        beneficiaryBank: 'bca',
        amount: 10000,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const messages = logError.mock.calls.map(([message]) => String(message)).join('\n');
    expect(messages).toContain('Iris payout failed [422]. Reference: WLT-20260820-000001');
    expect(messages).not.toContain('081234567890');
    expect(messages).not.toContain('Sensitive Recipient');
  });
});

describe('isMidtransNotFoundError (regresi circuit-breaker produksi)', () => {
  const configService = {
    get: jest.fn((key: string) => {
      if (key === 'midtrans.serverKey') return 'test-server-key';
      if (key === 'midtrans.isProduction') return false;
      return undefined;
    }),
  };

  beforeEach(() => {
    jest.restoreAllMocks();
    configService.get.mockClear();
  });

  it('mengenali MidtransError 404 dari httpStatusCode', async () => {
    const { isMidtransNotFoundError } = await import('./midtrans.service');
    const err = new Error(
      `Midtrans API is returning API error. HTTP status code: 404. API response: {"status_code":"404","status_message":"Transaction doesn't exist."}`,
    ) as Error & { httpStatusCode?: number };
    err.httpStatusCode = 404;
    err.name = 'MidtransError';
    expect(isMidtransNotFoundError(err)).toBe(true);
  });

  it('mengenali 404 dari ApiResponse.status_code string', async () => {
    const { isMidtransNotFoundError } = await import('./midtrans.service');
    const err = new Error(
      'Midtrans API is returning API error. HTTP status code: 404.',
    ) as Error & {
      ApiResponse?: Record<string, unknown>;
    };
    err.ApiResponse = { status_code: '404', status_message: "Transaction doesn't exist." };
    expect(isMidtransNotFoundError(err)).toBe(true);
  });

  it('tidak menganggap error jaringan sebagai not-found', async () => {
    const { isMidtransNotFoundError } = await import('./midtrans.service');
    expect(isMidtransNotFoundError(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toBe(false);
    expect(isMidtransNotFoundError(new Error('timeout of 30000ms exceeded'))).toBe(false);
    expect(isMidtransNotFoundError(null)).toBe(false);
  });

  it('getTransactionStatus melempar 404 apa adanya, bukan ServiceUnavailable', async () => {
    const { MidtransService } = await import('./midtrans.service');
    const service = new MidtransService(configService as never);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const midtransErr = new Error(
      'Midtrans API is returning API error. HTTP status code: 404. API response: {"status_code":"404"}',
    ) as Error & { httpStatusCode?: number };
    midtransErr.httpStatusCode = 404;
    midtransErr.name = 'MidtransError';
    (service as unknown as { coreApi: unknown }).coreApi = {
      transaction: { status: jest.fn().mockRejectedValue(midtransErr) },
    };
    await expect(service.getTransactionStatus('PAY-XYZ')).rejects.toBe(midtransErr);
    expect(warn.mock.calls.some(([m]) => String(m).includes('not found'))).toBe(true);
    jest.restoreAllMocks();
  });

  it('circuit breaker TIDAK terbuka walau 404 berulang (regresi produksi 2026-09-16)', async () => {
    const service = new MidtransService(configService as never);
    const notFound = new Error(
      'Midtrans API is returning API error. HTTP status code: 404. API response: {"status_code":"404"}',
    ) as Error & { httpStatusCode?: number };
    notFound.httpStatusCode = 404;
    notFound.name = 'MidtransError';
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const statusMock = jest.fn();
    for (let i = 0; i < 6; i++) statusMock.mockRejectedValueOnce(notFound);
    // Panggilan ke-7 berhasil — bukti circuit tidak pernah OPEN.
    statusMock.mockResolvedValueOnce({ transaction_status: 'settlement' } as never);
    (service as unknown as { coreApi: unknown }).coreApi = {
      transaction: { status: statusMock },
    };
    for (let i = 0; i < 6; i++) {
      await expect(service.getTransactionStatus(`PAY-404-${i}`)).rejects.toBe(notFound);
    }
    await expect(service.getTransactionStatus('PAY-OK')).resolves.toMatchObject({
      transaction_status: 'settlement',
    });
    jest.restoreAllMocks();
  });
});
