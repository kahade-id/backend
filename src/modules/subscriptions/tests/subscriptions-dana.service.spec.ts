import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SubscriptionsService } from '../subscriptions.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { WalletService } from '../../wallet/wallet.service';
import { VerificationBadgeService } from '../../users/verification-badge.service';
import { FlashQrisService } from '../../payment/flash-qris.service';
import { DanaPaymentService } from '../../payment/dana/dana-payment.service';
import { WalletModeService } from '../../wallet-mode/wallet-mode.service';
import { DanaDirectRefundService } from '../../no-wallet/dana-direct-refund.service';
import { DanaDirectPayKind } from '../../no-wallet/dto/dana-direct-pay.dto';
import { SubscriptionPlan, SubscriptionStatus, PaymentProvider, PaymentPurpose, PaymentStatus } from '@prisma/client';

/**
 * M2 — Subscriptions tanpa wallet (DANA direct).
 * Membuktikan: subscribeDana bikin subscription PENDING + order DANA;
 * aktivasi hanya via webhook (verify-via-API + cek nominal); renew
 * memperpanjang periode; fail-closed saat wallet nonaktif.
 */
describe('SubscriptionsService — DANA direct (tanpa wallet)', () => {
  let service: SubscriptionsService;
  let walletMode: { isWalletEnabled: jest.Mock };
  let danaPayment: { createOrder: jest.Mock; getPaymentDetail: jest.Mock };
  let prisma: any;

  const subRow = (overrides: any = {}) => ({
    id: 'sub-1',
    userId: 'user-1',
    plan: SubscriptionPlan.MONTHLY,
    status: SubscriptionStatus.PENDING,
    price: BigInt(9900000),
    currentPeriodStart: new Date(),
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    ...overrides,
  });

  const ptRow = (overrides: any = {}) => ({
    id: 'pt-sub-1',
    provider: PaymentProvider.DANA,
    purpose: PaymentPurpose.SUBSCRIPTION,
    status: PaymentStatus.PENDING,
    danaPayKind: 'QRIS',
    danaPartnerReferenceNo: 'KDH-REF123',
    grossAmount: BigInt(9900000),
    renewalForSubscriptionId: null,
    ...overrides,
  });

  beforeEach(async () => {
    walletMode = { isWalletEnabled: jest.fn(() => false) };
    danaPayment = {
      createOrder: jest.fn(async () => ({
        partnerReferenceNo: 'KDH-REF123',
        referenceNo: 'DANA-REF-1',
        paymentCode: 'QR-STRING-EMVCO',
        webRedirectUrl: undefined,
        amountIdr: 99000,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      })),
      getPaymentDetail: jest.fn(async () => ({ status: 'SUCCESS', amountIdr: 99000 })),
    };
    prisma = {
      subscription: {
        findFirst: jest.fn(async () => null),
        findMany: jest.fn(async () => []),
        findUnique: jest.fn(async () => null),
        create: jest.fn(async (a: any) => subRow(a.data)),
        update: jest.fn(async (a: any) => subRow(a.data)),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      paymentTransaction: {
        create: jest.fn(async (a: any) => ({ id: 'pt-sub-1', ...a.data })),
        update: jest.fn(async () => ({})),
        updateMany: jest.fn(async () => ({ count: 1 })),
        findUnique: jest.fn(async () => null),
      },
      user: {
        findUnique: jest.fn(async () => ({ kahadePlusSince: null, fullName: 'U', email: null, phoneNumber: null })),
        update: jest.fn(async () => ({})),
      },
      subscriptionPromoCode: { findUnique: jest.fn(async () => null), updateMany: jest.fn(async () => ({ count: 1 })) },
      campaign: { findFirst: jest.fn(async () => null) },
      $transaction: jest.fn(async (cb: any) => cb(prisma)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: { get: jest.fn(), setex: jest.fn(), del: jest.fn(async () => undefined) } },
        { provide: WalletTxSerialService, useValue: { getNext: jest.fn(async () => 1) } },
        { provide: ConfigService, useValue: { get: (k: string) => ({ 'app.subscriptionMonthlyPriceSen': 9900000, 'app.subscriptionYearlyPriceSen': 89900000 }[k] ?? null) } },
        { provide: AuditLogService, useValue: { logUserAction: jest.fn() } },
        { provide: WalletService, useValue: { verifyPin: jest.fn(async () => undefined) } },
        { provide: VerificationBadgeService, useValue: { invalidate: jest.fn(async () => undefined) } },
        { provide: FlashQrisService, useValue: {} },
        { provide: DanaPaymentService, useValue: danaPayment },
        { provide: WalletModeService, useValue: walletMode },
        { provide: DanaDirectRefundService, useValue: { refundAmount: jest.fn(async () => ({ refunded: true })) } },
      ],
    }).compile();
    service = module.get<SubscriptionsService>(SubscriptionsService);
  });

  describe('subscribeDana', () => {
    it('membuat subscription PENDING + order DANA QRIS (tanpa PIN, tanpa wallet)', async () => {
      const res = await service.subscribeDana('user-1', SubscriptionPlan.MONTHLY, DanaDirectPayKind.QRIS);
      expect(res.subscription.status).toBe(SubscriptionStatus.PENDING);
      expect(res.qrString).toBe('QR-STRING-EMVCO');
      expect(danaPayment.createOrder).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'QRIS', amountIdr: 99000 }),
      );
      const ptData = (prisma.paymentTransaction.create as jest.Mock).mock.calls[0][0].data;
      expect(ptData.provider).toBe(PaymentProvider.DANA);
      expect(ptData.purpose).toBe(PaymentPurpose.SUBSCRIPTION);
      expect(ptData.danaPayKind).toBe('QRIS');
    });

    it('VA wajib bankCode valid; BALANCE mengembalikan webRedirectUrl', async () => {
      await expect(service.subscribeDana('user-1', SubscriptionPlan.MONTHLY, DanaDirectPayKind.VA)).rejects.toThrow(
        expect.objectContaining({ response: expect.objectContaining({ code: 'DANA_VA_BANK_REQUIRED' }) }),
      );
      await expect(
        service.subscribeDana('user-1', SubscriptionPlan.MONTHLY, DanaDirectPayKind.VA, 'BOGUS'),
      ).rejects.toThrow(expect.objectContaining({ response: expect.objectContaining({ code: 'DANA_VA_BANK_REQUIRED' }) }));

      danaPayment.createOrder.mockResolvedValueOnce({
        partnerReferenceNo: 'KDH-REF2',
        referenceNo: 'DANA-REF-2',
        paymentCode: '3901088100001234',
        webRedirectUrl: undefined,
        amountIdr: 99000,
        expiresAt: new Date(),
      });
      const va = await service.subscribeDana('user-1', SubscriptionPlan.MONTHLY, DanaDirectPayKind.VA, 'bca');
      expect(va.paymentCode).toBe('3901088100001234');
      expect(danaPayment.createOrder).toHaveBeenCalledWith(expect.objectContaining({ bankCode: 'BCA' }));
    });

    it('gagalkan PENDING bila createOrder DANA gagal (fail-closed, bisa subscribe ulang)', async () => {
      danaPayment.createOrder.mockRejectedValueOnce(new Error('DANA down'));
      await expect(
        service.subscribeDana('user-1', SubscriptionPlan.MONTHLY, DanaDirectPayKind.QRIS),
      ).rejects.toThrow('DANA down');
      expect(prisma.subscription.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: SubscriptionStatus.EXPIRED }) }),
      );
    });
  });

  describe('activateDanaSubscription (webhook)', () => {
    it('aktivasi subscribe baru setelah verify-via-API OK', async () => {
      prisma.paymentTransaction.findUnique.mockResolvedValue({ ...ptRow(), subscriptions: [subRow()] });
      await service.activateDanaSubscription('pt-sub-1');
      expect(danaPayment.getPaymentDetail).toHaveBeenCalledWith('KDH-REF123');
      // klaim atomik payment PENDING→SUCCESS + subscription PENDING→ACTIVE
      expect(prisma.paymentTransaction.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: PaymentStatus.SUCCESS }) }),
      );
      expect(prisma.subscription.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: SubscriptionStatus.ACTIVE }) }),
      );
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ isKahadePlus: true }) }),
      );
    });

    it('TOLAK aktivasi bila nominal DANA mismatch (fail-closed)', async () => {
      prisma.paymentTransaction.findUnique.mockResolvedValue({ ...ptRow(), subscriptions: [subRow()] });
      danaPayment.getPaymentDetail.mockResolvedValueOnce({ status: 'SUCCESS', amountIdr: 50000 });
      await service.activateDanaSubscription('pt-sub-1');
      expect(prisma.paymentTransaction.updateMany).not.toHaveBeenCalled();
      expect(prisma.subscription.updateMany).not.toHaveBeenCalled();
    });

    it('TOLAK aktivasi bila status DANA bukan SUCCESS', async () => {
      prisma.paymentTransaction.findUnique.mockResolvedValue({ ...ptRow(), subscriptions: [subRow()] });
      danaPayment.getPaymentDetail.mockResolvedValueOnce({ status: 'FAILED', amountIdr: 99000 });
      await service.activateDanaSubscription('pt-sub-1');
      expect(prisma.paymentTransaction.updateMany).not.toHaveBeenCalled();
    });

    it('renewal: perpanjang currentPeriodEnd subscription yang ada', async () => {
      const active = subRow({ status: SubscriptionStatus.ACTIVE, currentPeriodEnd: new Date('2026-10-29T00:00:00Z') });
      prisma.paymentTransaction.findUnique.mockResolvedValue({
        ...ptRow({ renewalForSubscriptionId: 'sub-1', subscriptions: [] }),
      });
      prisma.subscription.findUnique.mockResolvedValue(active);
      await service.activateDanaSubscription('pt-sub-1');
      expect(prisma.subscription.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'sub-1' },
          data: expect.objectContaining({ status: SubscriptionStatus.ACTIVE }),
        }),
      );
      const newEnd = (prisma.subscription.update as jest.Mock).mock.calls[0][0].data.currentPeriodEnd as Date;
      expect(newEnd.getTime()).toBeGreaterThan(active.currentPeriodEnd.getTime());
    });
  });

  describe('renewDana', () => {
    it('membuat payment DANA renewal yang menunjuk subscription aktif', async () => {
      prisma.subscription.findFirst.mockResolvedValue(subRow({ status: SubscriptionStatus.ACTIVE }));
      const res = await service.renewDana('user-1', DanaDirectPayKind.QRIS);
      expect(res.qrString).toBe('QR-STRING-EMVCO');
      const ptData = (prisma.paymentTransaction.create as jest.Mock).mock.calls[0][0].data;
      expect(ptData.renewalForSubscriptionId).toBe('sub-1');
      expect(ptData.provider).toBe(PaymentProvider.DANA);
    });

    it('404 bila tidak ada subscription aktif', async () => {
      prisma.subscription.findFirst.mockResolvedValue(null);
      await expect(service.renewDana('user-1', DanaDirectPayKind.QRIS)).rejects.toThrow('No active subscription found');
    });
  });

  describe('fail-closed saat wallet nonaktif', () => {
    it('subscribe() berbayar via wallet DITOLAK (arahkan ke subscribe-dana)', async () => {
      await expect(service.subscribe('user-1', SubscriptionPlan.MONTHLY, '123456')).rejects.toThrow(
        expect.objectContaining({ response: expect.objectContaining({ code: 'WALLET_DISABLED_USE_DANA' }) }),
      );
    });

    it('renew() via wallet DITOLAK (arahkan ke renew-dana)', async () => {
      await expect(service.renew('user-1', '123456')).rejects.toThrow(
        expect.objectContaining({ response: expect.objectContaining({ code: 'WALLET_DISABLED_USE_DANA' }) }),
      );
    });

    it('subscribe() gratis (promo) tetap boleh tanpa PIN saat wallet nonaktif', async () => {
      prisma.subscriptionPromoCode.findUnique.mockResolvedValue({
        code: 'GRATIS30',
        status: 'ACTIVE',
        durationDays: 30,
        maxUses: 100,
        usedCount: 0,
      });
      // promo gratis → subscribe() gratis path; mock create subscription
      prisma.$transaction.mockImplementationOnce(async (cb: any) => cb(prisma));
      prisma.subscription.create.mockResolvedValueOnce(subRow({ status: SubscriptionStatus.ACTIVE, price: BigInt(0) }));
      const sub = await service.subscribe('user-1', SubscriptionPlan.MONTHLY, undefined, undefined, { promoCode: 'GRATIS30' });
      expect(sub.price).toBe(BigInt(0));
    });
  });
});
