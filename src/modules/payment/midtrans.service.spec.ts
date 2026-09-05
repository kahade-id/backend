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
      text: async () => JSON.stringify({
        payouts: [{ beneficiary_account: '081234567890', beneficiary_name: 'Sensitive Recipient' }],
      }),
    } as Response);
    const service = new MidtransService(configService as never);

    await expect(service.createIrisPayout({
      referenceNo: 'WLT-20260820-000001',
      beneficiaryName: 'Sensitive Recipient',
      beneficiaryAccount: '081234567890',
      beneficiaryBank: 'bca',
      amount: 10000,
    })).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const messages = logError.mock.calls.map(([message]) => String(message)).join('\n');
    expect(messages).toContain('Iris payout failed [422]. Reference: WLT-20260820-000001');
    expect(messages).not.toContain('081234567890');
    expect(messages).not.toContain('Sensitive Recipient');
  });
});
