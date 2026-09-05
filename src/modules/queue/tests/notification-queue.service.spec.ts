import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';
import { NotificationQueueService } from '../notification-queue.service';
import { NOTIFICATION_QUEUE } from '../processors/notification.processor';

describe('NotificationQueueService', () => {
  let svc: NotificationQueueService;
  const queue = { add: jest.fn(async () => undefined), addBulk: jest.fn(async () => undefined) };
  beforeEach(async () => {
    jest.resetAllMocks();
    const mod = await Test.createTestingModule({
      providers: [
        NotificationQueueService,
        { provide: getQueueToken(NOTIFICATION_QUEUE), useValue: queue },
      ],
    }).compile();
    svc = mod.get(NotificationQueueService);
  });
  it('defined', () => expect(svc).toBeDefined());
  it('enqueues with default language', async () => {
    await svc.enqueue({ userId: 'u1', type: 'ORDER_CREATED' as any, payload: { x: 1 } } as any);
    expect(queue.add).toHaveBeenCalled();
    const args = (queue.add.mock.calls as any[])[0];
    const data: any = args[1] ?? args[0];
    expect(data.language).toBe('id');
  });

  it('enqueues a notification batch with one bulk operation', async () => {
    await expect(svc.enqueueMany([
      { userId: 'u1', type: 'ORDER_CREATED' as any, title: 'T', body: 'B' },
      { userId: 'u2', type: 'ORDER_CREATED' as any, title: 'T', body: 'B' },
    ])).resolves.toBe(2);
    expect(queue.addBulk).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ name: 'send', data: expect.objectContaining({ userId: 'u1', language: 'id' }) }),
      expect.objectContaining({ name: 'send', data: expect.objectContaining({ userId: 'u2', language: 'id' }) }),
    ]));
  });

  it('does not throw when the broker is temporarily unavailable', async () => {
    queue.add.mockRejectedValueOnce(new Error('broker unavailable'));
    await expect(svc.enqueue({ userId: 'u1', type: 'ORDER_COMPLETED' as any, payload: { orderId: 'ORD-1' } } as any)).resolves.toBeUndefined();
  });
});
