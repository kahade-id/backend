import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { DanaDisbursementService } from './dana-disbursement.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock('./dana-snap.util', () => {
  const actual = jest.requireActual('./dana-snap.util');
  return {
    ...actual,
    signSnapRequest: () => ({ timestamp: 't', signature: 's', externalId: 'e' }),
    jakartaTimestamp: () => '2026-09-29T17:00:00+07:00',
  };
});

function makeService(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'dana.baseUrl': 'http://api.sandbox.dana.id',
    'dana.partnerId': 'PARTNER-1',
    'dana.privateKey': 'fake-key',
    'dana.origin': 'https://kahade.id',
    'dana.channelId': '95221',
    'dana.debug': true,
    ...overrides,
  };
  const config = { get: (key: string) => values[key] } as unknown as ConfigService;
  return new DanaDisbursementService(config);
}

describe('dana-disbursement.service', () => {
  beforeEach(() => jest.clearAllMocks());

  it('transferToBank: body + path sesuai fixture resmi', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { responseCode: '2001100', responseMessage: 'Successful', referenceNo: 'DB-1' },
    });
    const svc = makeService();
    const result = await svc.transferToBank({
      partnerReferenceNo: 'DANA-WD-001',
      beneficiaryAccountNumber: '1234567890',
      beneficiaryBankCode: '014',
      beneficiaryAccountName: 'Budi',
      amountIdr: 100000,
    });
    expect(result.status).toBe('SUCCESS');
    expect(result.referenceNo).toBe('DB-1');
    expect(mockedAxios.post.mock.calls[0][0]).toBe(
      'http://api.sandbox.dana.id/v1.0/emoney/transfer-bank.htm',
    );
    const body = JSON.parse(mockedAxios.post.mock.calls[0][1] as string);
    expect(body.partnerReferenceNo).toBe('DANA-WD-001');
    expect(body.beneficiaryAccountNumber).toBe('1234567890');
    expect(body.beneficiaryBankCode).toBe('014');
    expect(body.amount).toEqual({ value: '100000.00', currency: 'IDR' });
    expect(body.additionalInfo.fundType).toBe('MERCHANT_WITHDRAW_FOR_CORPORATE');
  });

  it('transferToBankStatus: memakai originalPartnerReferenceNo', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { responseCode: '2001100', latestTransactionStatus: '00', originalReferenceNo: 'DB-1' },
    });
    const svc = makeService();
    const result = await svc.transferToBankStatus('DANA-WD-001');
    expect(result.status).toBe('SUCCESS');
    expect(mockedAxios.post.mock.calls[0][0]).toContain('/v1.0/emoney/transfer-bank-status.htm');
    const body = JSON.parse(mockedAxios.post.mock.calls[0][1] as string);
    expect(body.originalPartnerReferenceNo).toBe('DANA-WD-001');
  });

  it('transferToDana: path /rest/v1.0/emoney/topup', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { responseCode: '2001200', referenceNo: 'DD-1' },
    });
    const svc = makeService();
    const result = await svc.transferToDana({
      partnerReferenceNo: 'DANA-TD-001',
      customerNumber: '6281234567890',
      amountIdr: 25000,
    });
    expect(result.status).toBe('SUCCESS');
    expect(mockedAxios.post.mock.calls[0][0]).toBe(
      'http://api.sandbox.dana.id/rest/v1.0/emoney/topup',
    );
    const body = JSON.parse(mockedAxios.post.mock.calls[0][1] as string);
    expect(body.customerNumber).toBe('6281234567890');
  });

  it('bankAccountInquiry: verified=true bila ada nama rekening', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        responseCode: '2001500',
        beneficiaryAccountName: 'BUDI SANTOSO',
      },
    });
    const svc = makeService();
    const result = await svc.bankAccountInquiry({
      partnerReferenceNo: 'DANA-INQ-001',
      beneficiaryAccountNumber: '1234567890',
      beneficiaryBankCode: '014',
    });
    expect(result.verified).toBe(true);
    expect(result.accountName).toBe('BUDI SANTOSO');
    expect(mockedAxios.post.mock.calls[0][0]).toContain('/v1.0/emoney/bank-account-inquiry.htm');
  });

  it('bankAccountInquiry: verified=false bila response non-200', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { responseCode: '4041501', responseMessage: 'Account not found' },
    });
    const svc = makeService();
    const result = await svc.bankAccountInquiry({
      partnerReferenceNo: 'DANA-INQ-002',
      beneficiaryAccountNumber: '000',
      beneficiaryBankCode: '014',
    });
    expect(result.verified).toBe(false);
    expect(result.accountName).toBeNull();
  });

  it('fail-closed bila kredensial belum dikonfigurasi', async () => {
    const svc = makeService({ 'dana.privateKey': '' });
    await expect(
      svc.transferToBank({
        partnerReferenceNo: 'X',
        beneficiaryAccountNumber: '1',
        beneficiaryBankCode: '014',
        amountIdr: 1000,
      }),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });
});
