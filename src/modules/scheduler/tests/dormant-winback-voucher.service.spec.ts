import { Test } from '@nestjs/testing';
import { NotificationType, VoucherApplicability, VoucherType } from '@prisma/client';
import { DormantWinbackVoucherService } from '../services/dormant-winback-voucher.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { NotificationQueueService } from '../../queue/notification-queue.service';

jest.mock('../../../common/utils/cron-jitter.util', () => ({
  cronJitter: jest.fn(async () => undefined),
}));

describe('DormantWinbackVoucherService', () => {
  it('issues one personal DORMANT_USER voucher and queues a promo notification', async () => {
    const prisma = {
      user: {
        findMany: jest.fn().mockResolvedValueOnce([{ id: 'user-1', userId: 'USR-00000001' }]),
      },
      voucher: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async ({ data }) => ({ id: 'voucher-1', code: data.code })),
      },
    };
    const redis = {
      isHealthy: jest.fn().mockResolvedValue(true),
      setNx: jest.fn().mockResolvedValue(true),
      releaseLock: jest.fn().mockResolvedValue(true),
    };
    const notificationQueue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const module = await Test.createTestingModule({
      providers: [
        DormantWinbackVoucherService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
        { provide: NotificationQueueService, useValue: notificationQueue },
      ],
    }).compile();

    await module.get(DormantWinbackVoucherService).issueMonthlyWinbackVouchers();

    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        totalOrdersCompleted: { gt: 0 },
        ordersAsBuyer: expect.objectContaining({ none: expect.any(Object) }),
        ordersAsSeller: expect.objectContaining({ none: expect.any(Object) }),
      }),
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }));
    expect(prisma.voucher.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        assignedToUserId: 'user-1',
        createdBy: 'SYSTEM_DORMANT_WINBACK',
        voucherType: VoucherType.FEE_DISCOUNT_FLAT,
        applicableTo: VoucherApplicability.DORMANT_USER,
        discountAmount: BigInt(1_000_000),
      }),
    }));
    expect(notificationQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      type: NotificationType.VOUCHER_ISSUED,
    }));
  });
});
