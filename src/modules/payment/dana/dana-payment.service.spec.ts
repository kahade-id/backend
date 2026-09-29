import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { DanaPaymentService, mapDanaTxStatus, parseDanaAmount, toDanaAmount } from './dana-payment.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

function makeService(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'dana.baseUrl': 'http://api.sandbox.dana.id',
    'dana.partnerId': 'PARTNER-1',
    'dana.privateKey': 'fake-key',
    'dana.merchantId': 'MERCHANT-1',
    'dana.origin': 'https://kahade.id',
    'dana.channelId': '95221',
    'dana.externalStoreId': 'STORE-1',
    'dana.webhookUrl': 'https://api.kahade.id/v1/webhooks/dana/payment',
    'dana.debug': true,
    'dana.orderExpiryMinutes': 30,
    ...overrides,
  };
  const config = {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
  return new DanaPaymentService(config);
}

// RSA key asli tidak dibutuhkan untuk mapping test — mock signSnapRequest
// via modul util agar fokus ke mapping body.
jest.mock('./dana-snap.util', () => {
  const actual = jest.requireActual('./dana-snap.util');
  return {
    ...actual,
    signSnapRequest: () => ({ timestamp: 't', signature: 's', externalId: 'e' }),
  };
});

describe('dana-payment.service', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('createOrder', () => {
    it('QRIS: payMethod NETWORK_PAY + payOption NETWORK_PAY_PG_QRIS + externalStoreId', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          responseCode: '2005400',
          responseMessage: 'Successful',
          referenceNo: 'DANA-REF-1',
          additionalInfo: { paymentCode: '000201010212...' },
        },
      });
      const svc = makeService();
      const order = await svc.createOrder({
        kind: 'QRIS',
        partnerReferenceNo: 'DANA-QR-001',
        amountIdr: 15000,
        orderTitle: 'Topup',
      });
      expect(order.paymentCode).toBe('000201010212...');
      expect(order.referenceNo).toBe('DANA-REF-1');
      const sentBody = JSON.parse(mockedAxios.post.mock.calls[0][1] as string);
      expect(sentBody.payOptionDetails).toEqual([
        {
          payMethod: 'NETWORK_PAY',
          payOption: 'NETWORK_PAY_PG_QRIS',
          transAmount: { value: '15000.00', currency: 'IDR' },
        },
      ]);
      expect(sentBody.externalStoreId).toBe('STORE-1');
      expect(sentBody.merchantId).toBe('MERCHANT-1');
      // Header SNAP terkirim
      const headers = mockedAxios.post.mock.calls[0][2]?.headers as Record<string, string>;
      expect(headers['X-PARTNER-ID']).toBe('PARTNER-1');
      expect(headers['X-SIGNATURE']).toBe('s');
      expect(headers['CHANNEL-ID']).toBe('95221');
    });

    it('QRIS: menolak partnerReferenceNo > 25 char', async () => {
      const svc = makeService();
      await expect(
        svc.createOrder({ kind: 'QRIS', partnerReferenceNo: 'X'.repeat(26), amountIdr: 1000 }),
      ).rejects.toThrow(BadRequestException);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('QRIS: fail-closed bila externalStoreId belum di-set', async () => {
      const svc = makeService({ 'dana.externalStoreId': '' });
      await expect(
        svc.createOrder({ kind: 'QRIS', partnerReferenceNo: 'DANA-QR-1', amountIdr: 1000 }),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('VA: payMethod VIRTUAL_ACCOUNT + payOption VIRTUAL_ACCOUNT_BRI', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          responseCode: '2005400',
          referenceNo: 'DANA-REF-2',
          additionalInfo: { paymentCode: '081234567890' },
        },
      });
      const svc = makeService();
      const order = await svc.createOrder({
        kind: 'VA',
        partnerReferenceNo: 'DANA-VA-001',
        amountIdr: 50000,
        bankCode: 'BRI',
      });
      expect(order.paymentCode).toBe('081234567890');
      const sentBody = JSON.parse(mockedAxios.post.mock.calls[0][1] as string);
      expect(sentBody.payOptionDetails[0].payMethod).toBe('VIRTUAL_ACCOUNT');
      expect(sentBody.payOptionDetails[0].payOption).toBe('VIRTUAL_ACCOUNT_BRI');
      expect(sentBody.externalStoreId).toBeUndefined();
    });

    it('BALANCE: payMethod BALANCE', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { responseCode: '2005400', referenceNo: 'DANA-REF-3', additionalInfo: {} },
      });
      const svc = makeService();
      await svc.createOrder({ kind: 'BALANCE', partnerReferenceNo: 'DANA-B-1', amountIdr: 20000 });
      const sentBody = JSON.parse(mockedAxios.post.mock.calls[0][1] as string);
      expect(sentBody.payOptionDetails[0].payMethod).toBe('BALANCE');
    });

    it('additionalInfo selalu memuat field wajib DANA (buyer, mcc, orderTerminalType)', async () => {
      // Tanpa ketiga field ini DANA mengembalikan 4005401 Invalid Field Format
      // (terbukti di E2E sandbox 2026-09-29; buyer boleh object kosong).
      mockedAxios.post.mockResolvedValueOnce({
        data: { responseCode: '2005400', referenceNo: 'DANA-REF-4', additionalInfo: { paymentCode: 'X' } },
      });
      const svc = makeService();
      await svc.createOrder({
        kind: 'VA',
        partnerReferenceNo: 'DANA-VA-002',
        amountIdr: 15000,
        bankCode: 'BRI',
      });
      const sentBody = JSON.parse(mockedAxios.post.mock.calls[0][1] as string);
      expect(sentBody.additionalInfo.order.buyer).toEqual({});
      expect(sentBody.additionalInfo.mcc).toBe('5732');
      expect(sentBody.additionalInfo.envInfo.orderTerminalType).toBe('WEB');
      expect(sentBody.additionalInfo.envInfo.sourcePlatform).toBe('IPG');
    });

    it('buyer diisi externalUserId bila diberikan', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { responseCode: '2005400', referenceNo: 'DANA-REF-5', additionalInfo: {} },
      });
      const svc = makeService();
      await svc.createOrder({
        kind: 'BALANCE',
        partnerReferenceNo: 'DANA-B-2',
        amountIdr: 20000,
        buyerExternalUserId: 'USER-9',
      });
      const sentBody = JSON.parse(mockedAxios.post.mock.calls[0][1] as string);
      expect(sentBody.additionalInfo.order.buyer).toEqual({ externalUserId: 'USER-9' });
    });

    it('fail-closed bila kredensial belum dikonfigurasi', async () => {
      const svc = makeService({ 'dana.partnerId': '', 'dana.privateKey': '' });
      await expect(
        svc.createOrder({ kind: 'QRIS', partnerReferenceNo: 'X', amountIdr: 1000 }),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('melempar bila DANA mengembalikan responseCode non-200', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { responseCode: '4005401', responseMessage: 'Invalid Field Format' },
      });
      const svc = makeService();
      await expect(
        svc.createOrder({ kind: 'QRIS', partnerReferenceNo: 'DANA-QR-1', amountIdr: 1000 }),
      ).rejects.toThrow(/Invalid Field Format/);
    });
  });

  describe('createCashierPayOrder', () => {
    it('sukses 2005400 → referenceNo; body sesuai fixture resmi IPG.json', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          responseCode: '2005400',
          responseMessage: 'Successful',
          referenceNo: 'DANA-CP-REF-1',
          webRedirectUrl: 'https://checkout.sandbox.dana.id/cashier/DANA-CP-REF-1',
        },
      });
      const svc = makeService();
      const order = await svc.createCashierPayOrder({
        partnerReferenceNo: 'DANA-CP-001',
        amountIdr: 75000,
        orderTitle: 'Escrow Payment',
      });
      expect(order.referenceNo).toBe('DANA-CP-REF-1');
      expect(order.webRedirectUrl).toBe(
        'https://checkout.sandbox.dana.id/cashier/DANA-CP-REF-1',
      );
      expect(order.amountIdr).toBe(75000);
      expect(order.expiresAt).toBeInstanceOf(Date);
      expect(mockedAxios.post.mock.calls[0][0]).toBe(
        'http://api.sandbox.dana.id/rest/redirection/v1.0/debit/payment-host-to-host',
      );
      const body = JSON.parse(mockedAxios.post.mock.calls[0][1] as string);
      expect(body.partnerReferenceNo).toBe('DANA-CP-001');
      expect(body.merchantId).toBe('MERCHANT-1');
      expect(body.amount).toEqual({ value: '75000.00', currency: 'IDR' });
      // Fixture resmi IPG.json: tanpa payOptionDetails / urlParams / validUpTo.
      expect(body.payOptionDetails).toBeUndefined();
      expect(body.urlParams).toBeUndefined();
      expect(body.validUpTo).toBeUndefined();
      expect(body.additionalInfo.productCode).toBe('51051000100000000001');
      expect(body.additionalInfo.mcc).toBe('5732');
      expect(body.additionalInfo.order.orderTitle).toBe('Escrow Payment');
      expect(body.additionalInfo.envInfo).toEqual({
        sourcePlatform: 'IPG',
        terminalType: 'WEB',
        orderTerminalType: 'WEB',
      });
    });

    it('expiryMinutes di-clamp maksimal 30 (hanya untuk expiresAt, tidak dikirim ke DANA)', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { responseCode: '2005400', referenceNo: 'DANA-CP-REF-2' },
      });
      const svc = makeService();
      const before = Date.now();
      const order = await svc.createCashierPayOrder({
        partnerReferenceNo: 'DANA-CP-002',
        amountIdr: 10000,
        expiryMinutes: 120,
      });
      const ttl = order.expiresAt.getTime() - before;
      expect(ttl).toBeGreaterThan(29 * 60_000);
      expect(ttl).toBeLessThanOrEqual(31 * 60_000);
    });

    it('melempar bila DANA mengembalikan responseCode non-200', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { responseCode: '4005401', responseMessage: 'Invalid Field Format' },
      });
      const svc = makeService();
      await expect(
        svc.createCashierPayOrder({
          partnerReferenceNo: 'DANA-CP-003',
          amountIdr: 10000,
        }),
      ).rejects.toThrow(/Invalid Field Format/);
    });

    it('fail-closed bila kredensial belum dikonfigurasi', async () => {
      const svc = makeService({ 'dana.merchantId': '', 'dana.privateKey': '' });
      await expect(
        svc.createCashierPayOrder({ partnerReferenceNo: 'X', amountIdr: 1000 }),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });
  });

  describe('getPaymentDetail', () => {
    it('memetakan latestTransactionStatus + amount', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          responseCode: '2005500',
          latestTransactionStatus: '00',
          originalReferenceNo: 'DANA-REF-1',
          originalPartnerReferenceNo: 'DANA-QR-001',
          transAmount: { value: '15000.00', currency: 'IDR' },
        },
      });
      const svc = makeService();
      const detail = await svc.getPaymentDetail('DANA-QR-001');
      expect(detail.status).toBe('SUCCESS');
      expect(detail.amountIdr).toBe(15000);
      const sentBody = JSON.parse(mockedAxios.post.mock.calls[0][1] as string);
      expect(sentBody.originalPartnerReferenceNo).toBe('DANA-QR-001');
      expect(sentBody.serviceCode).toBe('54');
    });

    it('UNKNOWN bila query gagal (untuk fail-closed di settlement)', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { responseCode: '4045501', responseMessage: 'Not found' },
      });
      const svc = makeService();
      const detail = await svc.getPaymentDetail('NOPE');
      expect(detail.status).toBe('UNKNOWN');
      expect(detail.amountIdr).toBeNull();
    });
  });

  describe('helpers', () => {
    it('mapDanaTxStatus', () => {
      expect(mapDanaTxStatus('00')).toBe('SUCCESS');
      expect(mapDanaTxStatus('01')).toBe('PENDING');
      expect(mapDanaTxStatus('02')).toBe('PENDING');
      expect(mapDanaTxStatus('05')).toBe('EXPIRED');
      expect(mapDanaTxStatus('07')).toBe('UNKNOWN');
      expect(mapDanaTxStatus(undefined)).toBe('UNKNOWN');
    });

    it('toDanaAmount / parseDanaAmount', () => {
      expect(toDanaAmount(15000)).toBe('15000.00');
      expect(parseDanaAmount('15000.00')).toBe(15000);
      expect(parseDanaAmount('xx')).toBeNull();
      expect(() => toDanaAmount(-5)).toThrow(BadRequestException);
    });
  });
});
