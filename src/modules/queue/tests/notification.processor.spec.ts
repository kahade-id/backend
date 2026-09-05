import { NotificationType, Prisma } from '@prisma/client';
import { NotificationProcessor } from '../processors/notification.processor';

describe('NotificationProcessor', () => {
  const prisma = {
    notification: { create: jest.fn() },
    emitNotificationCreated: jest.fn(),
  };
  const deadLetterQueue = { add: jest.fn() };
  let processor: NotificationProcessor;

  beforeEach(() => {
    jest.resetAllMocks();
    processor = new NotificationProcessor(prisma as any, deadLetterQueue as any);
  });

  it('persists before delivery and includes public notification identity in push data', async () => {
    prisma.notification.create.mockResolvedValue({ notifId: 'NTF-public-123' });
    const job = {
      id: 'job-1',
      attemptsMade: 0,
      data: {
        userId: 'user-1',
        type: NotificationType.ORDER_NEW,
        title: 'Pesanan baru',
        body: 'Ada pesanan baru untuk Anda.',
        actionUrl: '/order/ORD-20260819-000001-OMXX',
        pushData: { orderId: 'ORD-20260819-000001-OMXX' },
      },
    } as any;

    await processor.handleSendNotification(job);

    expect(prisma.notification.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'user-1', actionUrl: '/order/ORD-20260819-000001-OMXX' }),
    }));
    expect(prisma.emitNotificationCreated).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      data: expect.objectContaining({
        notificationId: 'NTF-public-123',
        actionUrl: '/order/ORD-20260819-000001-OMXX',
        notificationType: NotificationType.ORDER_NEW,
      }),
    }));
  });

  it('does not emit another push when a retried job hits the stable-id uniqueness constraint', async () => {
    prisma.notification.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('duplicate notification', { code: 'P2002', clientVersion: 'test', meta: { target: ['notifId'] } }));
    const job = { id: 'job-2', attemptsMade: 1, data: { userId: 'user-1', type: NotificationType.ORDER_NEW, title: 'Pesanan baru', body: 'Ada pesanan baru.' } } as any;

    await expect(processor.handleSendNotification(job)).resolves.toBeUndefined();

    expect(prisma.emitNotificationCreated).not.toHaveBeenCalled();
  });

  it('derives a canonical order route before persistence when the producer only supplies orderId', async () => {
    prisma.notification.create.mockResolvedValue({ notifId: 'NTF-public-456' });
    const job = { id: 'job-3', attemptsMade: 0, data: { userId: 'user-1', type: NotificationType.ORDER_PAYMENT_RECEIVED, title: 'Pembayaran diterima', body: 'Pesanan siap diproses.', pushData: { orderId: 'ORD-20260819-000001-OMXX' } } } as any;

    await processor.handleSendNotification(job);

    expect(prisma.notification.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ actionUrl: '/order/ORD-20260819-000001-OMXX' }),
    }));
    expect(prisma.emitNotificationCreated).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ actionUrl: '/order/ORD-20260819-000001-OMXX' }),
    }));
  });
});
