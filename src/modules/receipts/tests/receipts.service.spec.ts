import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { ReceiptsService } from '../receipts.service';
import { ReceiptKind } from '../dto/create-receipt-token.dto';
import { PrismaService } from '../../../prisma/prisma.service';

const TEST_SECRET = 'test-hmac-secret-untuk-unit-test-32char';
const TTL_SECONDS = 2 * 365 * 24 * 3600;

const mockConfig = {
  get: jest.fn((key: string) => configValue(key)),
};

function configValue(key: string): string | number | undefined {
  if (key === 'receipt.hmacSecret') return TEST_SECRET;
  if (key === 'receipt.publicBaseUrl') return 'https://api.test';
  if (key === 'receipt.ttlSeconds') return TTL_SECONDS;
  return undefined;
}

const mockPrisma = {
  walletTransaction: { findFirst: jest.fn() },
  order: { findFirst: jest.fn() },
  paymentTransaction: { findFirst: jest.fn() },
};

const walletTxRecord = {
  type: 'TRANSFER_SENT',
  status: 'SUCCESS',
  withdrawStatus: null,
  amount: BigInt(15000000), // 150.000 IDR dalam sen
  completedAt: new Date('2026-09-20T10:00:00.000Z'),
  createdAt: new Date('2026-09-20T09:59:00.000Z'),
};

/** Menandatangani payload mentah persis seperti implementasi (untuk token uji). */
function craftToken(payload: object, secret: string = TEST_SECRET): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sigB64 = createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sigB64}`;
}

describe('ReceiptsService', () => {
  let service: ReceiptsService;

  beforeEach(async () => {
    jest.resetAllMocks();
    // resetAllMocks menghapus implementasi jest.fn(impl) → pasang ulang
    mockConfig.get.mockImplementation(configValue);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReceiptsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    service = module.get<ReceiptsService>(ReceiptsService);
  });

  describe('createToken', () => {
    it('menerbitkan token + verifyUrl untuk record milik user', async () => {
      mockPrisma.walletTransaction.findFirst.mockResolvedValue(walletTxRecord);

      const result = await service.createToken('user-1', {
        kind: ReceiptKind.TRANSFER,
        referenceId: 'WLT-20260920-0001',
      });

      expect(result.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      expect(result.verifyUrl).toBe(`https://api.test/v1/receipts/verify/${result.token}`);
      // Ownership filter: query harus menyertakan wallet.userId
      const where = mockPrisma.walletTransaction.findFirst.mock.calls[0][0].where;
      expect(JSON.stringify(where)).toContain('user-1');
    });

    it('fail-closed: 404 bila record bukan milik user / tidak ada', async () => {
      mockPrisma.walletTransaction.findFirst.mockResolvedValue(null);
      await expect(
        service.createToken('user-1', { kind: ReceiptKind.WALLET_TX, referenceId: 'WLT-X' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('fail-closed: 404 bila kind tidak cocok dengan tipe record', async () => {
      // kind WITHDRAWAL tapi record bertipe TRANSFER → resolver mengembalikan null
      mockPrisma.walletTransaction.findFirst.mockResolvedValue(null);
      await expect(
        service.createToken('user-1', { kind: ReceiptKind.WITHDRAWAL, referenceId: 'WLT-20260920-0001' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('fail-closed: error bila secret belum dikonfigurasi', async () => {
      const noSecretConfig = { get: jest.fn(() => undefined) };
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ReceiptsService,
          { provide: PrismaService, useValue: mockPrisma },
          { provide: ConfigService, useValue: noSecretConfig },
        ],
      }).compile();
      const svc = module.get<ReceiptsService>(ReceiptsService);
      mockPrisma.walletTransaction.findFirst.mockResolvedValue(walletTxRecord);
      await expect(
        svc.createToken('user-1', { kind: ReceiptKind.WALLET_TX, referenceId: 'WLT-1' }),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('verifyToken', () => {
    it('token valid → 200 payload tanpa PII, status CURRENT dari DB', async () => {
      mockPrisma.walletTransaction.findFirst.mockResolvedValue(walletTxRecord);
      const { token } = await service.createToken('user-1', {
        kind: ReceiptKind.TRANSFER,
        referenceId: 'WLT-20260920-0001',
      });

      // Simulasi status berubah setelah token diterbitkan → harus ikut data terbaru
      mockPrisma.walletTransaction.findFirst.mockResolvedValue({
        ...walletTxRecord,
        status: 'REVERSED',
      });

      const result = await service.verifyToken(token);
      expect(result).toEqual({
        valid: true,
        kind: ReceiptKind.TRANSFER,
        status: 'REVERSED',
        amount: '15000000',
        currency: 'IDR',
        occurredAt: '2026-09-20T10:00:00.000Z',
      });

      // TANPA PII: key persis sesuai kontrak, tidak ada nama/phone/email
      expect(Object.keys(result).sort()).toEqual(
        ['amount', 'currency', 'kind', 'occurredAt', 'status', 'valid'].sort(),
      );
      expect(JSON.stringify(result)).not.toMatch(/628|@|phone|email|name/i);
    });

    it('token dengan format salah → invalid', async () => {
      for (const bad of ['', 'abc', 'a.b.c', '!!!.@@@', '.sig', 'payload.']) {
        expect(await service.verifyToken(bad)).toEqual({ valid: false });
      }
    });

    it('token yang di-tamper (payload diubah) → invalid', async () => {
      mockPrisma.walletTransaction.findFirst.mockResolvedValue(walletTxRecord);
      const { token } = await service.createToken('user-1', {
        kind: ReceiptKind.TRANSFER,
        referenceId: 'WLT-20260920-0001',
      });
      const [payloadB64, sigB64] = token.split('.');
      const tamperedPayload = payloadB64.slice(0, -2) + (payloadB64.endsWith('AA') ? 'BB' : 'AA');
      expect(await service.verifyToken(`${tamperedPayload}.${sigB64}`)).toEqual({ valid: false });

      // Signature diganti juga → invalid
      const fakeSig = 'A'.repeat(sigB64.length);
      expect(await service.verifyToken(`${payloadB64}.${fakeSig}`)).toEqual({ valid: false });
    });

    it('token ditandatangani secret lain → invalid', async () => {
      const iat = Math.floor(Date.now() / 1000);
      const foreign = craftToken({ k: ReceiptKind.TOPUP, r: 'pay-1', iat }, 'secret-milik-orang-lain');
      expect(await service.verifyToken(foreign)).toEqual({ valid: false });
    });

    it('token kedaluwarsa (iat > 2 tahun) → invalid', async () => {
      const oldIat = Math.floor(Date.now() / 1000) - (3 * 365 * 24 * 3600);
      const expired = craftToken({ k: ReceiptKind.TOPUP, r: 'pay-1', iat: oldIat });
      expect(await service.verifyToken(expired)).toEqual({ valid: false });
    });

    it('token dengan iat di masa depan (melebihi skew) → invalid', async () => {
      const futureIat = Math.floor(Date.now() / 1000) + 3600;
      const future = craftToken({ k: ReceiptKind.TOPUP, r: 'pay-1', iat: futureIat });
      expect(await service.verifyToken(future)).toEqual({ valid: false });
    });

    it('token dengan kind tak dikenal → invalid', async () => {
      const iat = Math.floor(Date.now() / 1000);
      const weird = craftToken({ k: 'HACKED', r: 'x', iat });
      expect(await service.verifyToken(weird)).toEqual({ valid: false });
    });

    it('record sumber hilang → invalid (fail-closed)', async () => {
      mockPrisma.walletTransaction.findFirst.mockResolvedValue(walletTxRecord);
      const { token } = await service.createToken('user-1', {
        kind: ReceiptKind.WALLET_TX,
        referenceId: 'WLT-20260920-0001',
      });
      mockPrisma.walletTransaction.findFirst.mockResolvedValue(null);
      expect(await service.verifyToken(token)).toEqual({ valid: false });
    });

    it('ORDER_PAYMENT: hanya buyer/seller yang bisa menerbitkan token', async () => {
      mockPrisma.order.findFirst.mockResolvedValue(null);
      await expect(
        service.createToken('orang-asing', { kind: ReceiptKind.ORDER_PAYMENT, referenceId: 'ORD-1' }),
      ).rejects.toThrow(NotFoundException);
      const where = mockPrisma.order.findFirst.mock.calls[0][0].where;
      expect(JSON.stringify(where)).toContain('orang-asing');
    });

    it('WITHDRAWAL memakai withdrawStatus bila ada', async () => {
      mockPrisma.walletTransaction.findFirst.mockResolvedValue({
        type: 'WITHDRAW',
        status: 'SUCCESS',
        withdrawStatus: 'PROCESSING',
        amount: BigInt(50000000),
        completedAt: null,
        createdAt: new Date('2026-09-21T08:00:00.000Z'),
      });
      const { token } = await service.createToken('user-1', {
        kind: ReceiptKind.WITHDRAWAL,
        referenceId: 'WLT-20260921-0009',
      });
      const result = await service.verifyToken(token);
      expect(result).toMatchObject({ valid: true, status: 'PROCESSING', amount: '50000000' });
    });
  });

  describe('renderReceiptHtml', () => {
    const validResult = {
      valid: true as const,
      kind: ReceiptKind.TOPUP,
      status: 'SUCCESS',
      amount: '100000000',
      currency: 'IDR' as const,
      occurredAt: '2026-09-20T10:00:00.000Z',
    };

    it('struk valid → halaman HTML rapi berisi status/nominal/tanggal', () => {
      const html = service.renderReceiptHtml(validResult);
      expect(html).toContain('Struk valid');
      expect(html).toContain('Rp 1.000.000');
      expect(html).toContain('Berhasil');
      expect(html).toContain('Top-up Saldo');
      expect(html).not.toMatch(/628|@|phone|email/i);
    });

    it('struk invalid → halaman "tidak ditemukan"', () => {
      const html = service.renderReceiptHtml({ valid: false });
      expect(html).toContain('tidak ditemukan');
    });

    it('melakukan escape HTML pada nilai yang dirender', () => {
      const html = service.renderReceiptHtml({
        ...validResult,
        status: '<script>alert(1)</script>',
      });
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;');
    });
  });
});
