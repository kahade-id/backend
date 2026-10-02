import { PaymentStatus } from '@prisma/client';
import { DanaPaymentReconcileService } from '../dana-payment-reconcile.service';
import type { DanaPaymentService } from '../../../payment/dana/dana-payment.service';
import type { DanaDirectPaymentService } from '../../../no-wallet/dana-direct-payment.service';
import { PrismaService } from '../../../../prisma/prisma.service';
import { RedisService } from '../../../../redis/redis.service';

jest.mock('../../../../common/utils/cron-jitter.util', () => ({
  cronJitter: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../common/utils/redis-health.util', () => ({
  ensureRedisAvailable: jest.fn().mockResolvedValue(true),
  alertMoneyCronSkippedRedisDown: jest.fn(),
}));
jest.mock('../../common/money-alert.util', () => ({
  alertAdminsOnMoneyAnomaly: jest.fn().mockResolvedValue(true),
}));

import { alertAdminsOnMoneyAnomaly } from '../../common/money-alert.util';

const alertMock = alertAdminsOnMoneyAnomaly as unknown as jest.Mock;

const makeRedis = () =>
  ({
    setNx: jest.fn().mockResolvedValue(true),
    setex: jest.fn().mockResolvedValue('OK'),
    releaseLock: jest.fn().mockResolvedValue(true),
  }) as unknown as RedisService;

interface Mocks {
  getPaymentDetail: jest.Mock;
  settleEscrow: jest.Mock;
  paymentUpdateMany: jest.Mock;
}

function makeService(payment: unknown, danaDetail?: unknown, danaThrows = false): { svc: DanaPaymentReconcileService; mocks: Mocks } {
  const getPaymentDetail = danaThrows
    ? jest.fn().mockRejectedValue(new Error('DANA timeout'))
    : jest.fn().mockResolvedValue(danaDetail);
  const settleEscrow = jest.fn().mockResolvedValue('SETTLED');
  const paymentUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    paymentTransaction: {
      findUnique: jest.fn().mockResolvedValue(payment),
      updateMany: paymentUpdateMany,
    },
  } as unknown as PrismaService;
  const svc = new DanaPaymentReconcileService(
    prisma,
    makeRedis(),
    { getPaymentDetail } as unknown as DanaPaymentService,
    { settleEscrow } as unknown as DanaDirectPaymentService,
  );
  return { svc, mocks: { getPaymentDetail, settleEscrow, paymentUpdateMany } };
}

const PENDING_PAYMENT = {
  id: 'pay-1',
  orderId: 'ord-1',
  status: PaymentStatus.PENDING,
  grossAmount: BigInt(10000000), // Rp100.000 → 100000 IDR
  createdAt: new Date(Date.now() - 3600_000),
  updatedAt: new Date(Date.now() - 3600_000),
};

const SUCCESS_DETAIL = {
  status: 'SUCCESS',
  amountIdr: 100000,
  referenceNo: 'REF-1',
  partnerReferenceNo: 'R-1',
};

describe('DanaPaymentReconcileService (SYS-B-305)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('payment tak ditemukan → NOT_APPLICABLE', async () => {
    const { svc } = makeService(null);
    await expect(svc.reconcileByPartnerReferenceNo('R-X')).resolves.toBe('NOT_APPLICABLE');
  });

  it('payment sudah SUCCESS → ALREADY_SETTLED (idempoten)', async () => {
    const { svc, mocks } = makeService({ ...PENDING_PAYMENT, status: PaymentStatus.SUCCESS });
    await expect(svc.reconcileByPartnerReferenceNo('R-1')).resolves.toBe('ALREADY_SETTLED');
    expect(mocks.getPaymentDetail).not.toHaveBeenCalled();
  });

  it('DANA SUCCESS + nominal cocok → settleEscrow → SETTLED', async () => {
    const { svc, mocks } = makeService(PENDING_PAYMENT, SUCCESS_DETAIL);
    await expect(svc.reconcileByPartnerReferenceNo('R-1')).resolves.toBe('SETTLED');
    expect(mocks.settleEscrow).toHaveBeenCalledWith('pay-1');
    expect(alertMock).not.toHaveBeenCalled();
  });

  it('DANA SUCCESS + nominal TAK cocok → fail-closed: AMOUNT_MISMATCH + alert, tanpa settlement', async () => {
    const { svc, mocks } = makeService(PENDING_PAYMENT, { ...SUCCESS_DETAIL, amountIdr: 50000 });
    await expect(svc.reconcileByPartnerReferenceNo('R-1')).resolves.toBe('AMOUNT_MISMATCH');
    expect(mocks.settleEscrow).not.toHaveBeenCalled();
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock.mock.calls[0][0].title).toContain('Nominal DANA tak cocok');
  });

  it('DANA EXPIRED → payment PENDING→EXPIRED (transisi atomik berpredikat)', async () => {
    const { svc, mocks } = makeService(PENDING_PAYMENT, {
      status: 'EXPIRED',
      amountIdr: null,
      referenceNo: '',
      partnerReferenceNo: 'R-1',
    });
    await expect(svc.reconcileByPartnerReferenceNo('R-1')).resolves.toBe('MARKED_EXPIRED');
    expect(mocks.paymentUpdateMany).toHaveBeenCalledWith({
      where: { id: 'pay-1', status: PaymentStatus.PENDING },
      data: { status: PaymentStatus.EXPIRED, failedAt: expect.any(Date) },
    });
  });

  it('query DANA gagal → ERROR (coba lagi nanti, tanpa perubahan)', async () => {
    const { svc, mocks } = makeService(PENDING_PAYMENT, undefined, true);
    await expect(svc.reconcileByPartnerReferenceNo('R-1')).resolves.toBe('ERROR');
    expect(mocks.settleEscrow).not.toHaveBeenCalled();
    expect(mocks.paymentUpdateMany).not.toHaveBeenCalled();
  });

  it('settleEscrow menolak (order tak eligible) → NEEDS_MANUAL_REFUND + alert URGENT, tanpa auto-refund', async () => {
    const { svc, mocks } = makeService(PENDING_PAYMENT, SUCCESS_DETAIL);
    mocks.settleEscrow.mockRejectedValue(new Error('order CANCELLED'));
    await expect(svc.reconcileByPartnerReferenceNo('R-1')).resolves.toBe('NEEDS_MANUAL_REFUND');
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock.mock.calls[0][0].title).toContain('URGENT');
  });

  it('PENDING >24 jam dengan status DANA tak jelas → alert unexplained-pending', async () => {
    const old = {
      ...PENDING_PAYMENT,
      createdAt: new Date(Date.now() - 25 * 3600_000),
    };
    const { svc } = makeService(old, {
      status: 'UNKNOWN',
      amountIdr: null,
      referenceNo: '',
      partnerReferenceNo: 'R-1',
    });
    await expect(svc.reconcileByPartnerReferenceNo('R-1')).resolves.toBe('STILL_PENDING');
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock.mock.calls[0][0].title).toContain('PENDING >24 jam');
  });
});
