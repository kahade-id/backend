import { ExpireUnpaidOrdersService } from '../expire-unpaid-orders.service';
import type { DanaPaymentService } from '../../../payment/dana/dana-payment.service';
import { PrismaService } from '../../../../prisma/prisma.service';
import { RedisService } from '../../../../redis/redis.service';

function makeService(pendingPayments: unknown[], cancelThrows = false) {
  const cancelOrder = cancelThrows
    ? jest.fn().mockRejectedValue(new Error('DANA 500'))
    : jest.fn().mockResolvedValue(undefined);
  const paymentUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    paymentTransaction: {
      findMany: jest.fn().mockResolvedValue(pendingPayments),
      updateMany: paymentUpdateMany,
    },
  } as unknown as PrismaService;
  const redis = {} as unknown as RedisService;
  const svc = new ExpireUnpaidOrdersService(
    prisma,
    redis,
    { cancelOrder } as unknown as DanaPaymentService,
  );
  return { svc, cancelOrder, paymentUpdateMany };
}

describe('ExpireUnpaidOrdersService.cancelDanaPaymentsForOrder (SYS-B-305c)', () => {
  it('payment DANA PENDING → cancelOrder ke DANA + tandai EXPIRED', async () => {
    const { svc, cancelOrder, paymentUpdateMany } = makeService([
      { id: 'pay-1', danaPartnerReferenceNo: 'R-1' },
    ]);
    await (svc as unknown as { cancelDanaPaymentsForOrder(o: string, p: string): Promise<void> })
      .cancelDanaPaymentsForOrder('ord-db-1', 'ORD-20251003-001');

    expect(cancelOrder).toHaveBeenCalledWith(
      'R-1',
      expect.stringContaining('ORD-20251003-001'),
    );
    expect(paymentUpdateMany).toHaveBeenCalledWith(
      { where: { id: 'pay-1', status: 'PENDING' }, data: { status: 'EXPIRED', failedAt: expect.any(Date) } },
    );
  });

  it('cancelOrder DANA gagal → payment dibiarkan PENDING (fail-closed, dipulihkan reconcile cron)', async () => {
    const { svc, cancelOrder, paymentUpdateMany } = makeService(
      [{ id: 'pay-1', danaPartnerReferenceNo: 'R-1' }],
      true,
    );
    await (svc as unknown as { cancelDanaPaymentsForOrder(o: string, p: string): Promise<void> })
      .cancelDanaPaymentsForOrder('ord-db-1', 'ORD-20251003-001');

    expect(cancelOrder).toHaveBeenCalledTimes(1);
    // Status sisi DANA belum pasti — JANGAN tandai EXPIRED.
    expect(paymentUpdateMany).not.toHaveBeenCalled();
  });

  it('tak ada payment PENDING → tak ada panggilan DANA', async () => {
    const { svc, cancelOrder } = makeService([]);
    await (svc as unknown as { cancelDanaPaymentsForOrder(o: string, p: string): Promise<void> })
      .cancelDanaPaymentsForOrder('ord-db-1', 'ORD-20251003-001');
    expect(cancelOrder).not.toHaveBeenCalled();
  });
});
