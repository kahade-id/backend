/**
 * Batch 8 (MONEY) — EO-007: fee waiver Kahade+ berlaku juga untuk subscription
 * CANCELLED yang masih dalam masa berbayar (cancel-at-period-end),
 * selaras dengan eligibilitas tarif Plus di orders.service.
 */
import { SubscriptionStatus } from '@prisma/client';
import { SubscriptionsService } from '../subscriptions.service';

function makeService(prisma: any) {
  const config = { get: jest.fn(() => undefined) };
  return new SubscriptionsService(
    prisma,
    {} as never,
    {} as never,
    config as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe('Batch 8 money — EO-007 waiver untuk cancel-at-period-end', () => {
  it('waiveFeeIfEligible mencari subscription dengan status [ACTIVE, CANCELLED]', async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 'sub-1' });
    const usageUpsert = jest.fn().mockResolvedValue({ id: 'usage-1' });
    const prisma = {
      subscription: { findFirst },
      subscriptionUsage: {
        upsert: usageUpsert,
        update: jest.fn().mockResolvedValue({}),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ feeWaivedAmount: BigInt(0) }]),
    };
    const service = makeService(prisma);

    const feeSen = BigInt(500000); // Rp5.000
    const result = await service.waiveFeeIfEligible('user-1', feeSen);

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-1',
          status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.CANCELLED] },
        }),
      }),
    );
    // Kuota default cukup → fee dibebaskan penuh.
    expect(result).toBe(BigInt(0));
  });

  it('waiveFeeIfEligible mengembalikan fee utuh bila tidak ada subscription yang eligible', async () => {
    const prisma = {
      subscription: { findFirst: jest.fn().mockResolvedValue(null) },
      subscriptionUsage: { upsert: jest.fn(), update: jest.fn() },
      $queryRaw: jest.fn(),
    };
    const service = makeService(prisma);

    const feeSen = BigInt(500000);
    await expect(service.waiveFeeIfEligible('user-1', feeSen)).resolves.toBe(feeSen);
  });

  it('estimateWaiverAmount memakai kriteria benefit yang sama (termasuk CANCELLED)', async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 'sub-1' });
    const prisma = {
      subscription: { findFirst },
      subscriptionUsage: {
        findUnique: jest.fn().mockResolvedValue({ feeWaivedAmount: BigInt(0) }),
      },
    };
    const service = makeService(prisma);

    const waived = await service.estimateWaiverAmount('user-1', BigInt(300000));
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.CANCELLED] },
        }),
      }),
    );
    expect(waived).toBe(BigInt(300000));
  });
});
