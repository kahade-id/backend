jest.mock('../../../common/utils/cron-jitter.util', () => ({
  cronJitter: jest.fn().mockResolvedValue(undefined),
}));

import { WebhookRetryService } from '../services/webhook-retry.service';

const notification = {
  order_id: 'ORDER-1',
  status_code: '200',
  gross_amount: '10000.00',
  signature_key: 'signature',
  transaction_status: 'settlement',
  transaction_id: 'txn-1',
};

describe('WebhookRetryService', () => {
  const prisma = {
    webhookLog: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
  };
  const redis = {
    isHealthy: jest.fn(),
    setNx: jest.fn(),
    releaseLock: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
  };
  const paymentService = {
    handleMidtransWebhook: jest.fn(),
  };
  const config = {
    get: jest.fn().mockReturnValue(25),
  };

  let service: WebhookRetryService;

  beforeEach(() => {
    jest.clearAllMocks();
    redis.isHealthy.mockResolvedValue(true);
    redis.setNx.mockResolvedValue(true);
    redis.releaseLock.mockResolvedValue(true);
    redis.setex.mockResolvedValue('OK');
    redis.del.mockResolvedValue(1);
    prisma.webhookLog.updateMany.mockResolvedValue({ count: 1 });
    prisma.webhookLog.count.mockResolvedValue(0);
    service = new WebhookRetryService(prisma as never, redis as never, paymentService as never, config as never);
  });

  it('replays eligible inbox rows and records a heartbeat', async () => {
    prisma.webhookLog.findMany.mockResolvedValue([{
      id: 'log-1',
      payload: notification,
      ipAddress: '103.10.10.10',
      retryCount: 1,
      isProcessed: false,
      deadLetteredAt: null,
    }]);
    paymentService.handleMidtransWebhook.mockResolvedValue({ message: 'OK' });

    await service.retryFailedWebhooks();

    expect(paymentService.handleMidtransWebhook).toHaveBeenCalledWith(notification, '103.10.10.10');
    expect(prisma.webhookLog.updateMany).not.toHaveBeenCalled();
    expect(redis.setex).toHaveBeenCalledWith(
      'cron_heartbeat:webhook_inbox_retry',
      86400,
      expect.stringContaining('"processed":1'),
    );
    expect(prisma.webhookLog.count).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ retryCount: { lt: 5 } }),
    }));
    expect(redis.releaseLock).toHaveBeenCalled();
  });

  it('schedules a failed replay with bounded backoff', async () => {
    prisma.webhookLog.findMany.mockResolvedValue([{
      id: 'log-2',
      payload: notification,
      ipAddress: '103.10.10.10',
      retryCount: 2,
      isProcessed: false,
      deadLetteredAt: null,
    }]);
    paymentService.handleMidtransWebhook.mockRejectedValue(new Error('temporary failure'));

    await service.retryFailedWebhooks();

    expect(prisma.webhookLog.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'log-2', isProcessed: false, retryCount: 2 },
      data: expect.objectContaining({
        retryCount: { increment: 1 },
        errorMessage: 'temporary failure',
        deadLetteredAt: null,
        nextRetryAt: expect.any(Date),
      }),
    }));
  });

  it('dead-letters a row after the maximum attempt', async () => {
    prisma.webhookLog.findMany.mockResolvedValue([{
      id: 'log-3',
      payload: notification,
      ipAddress: '103.10.10.10',
      retryCount: 4,
      isProcessed: false,
      deadLetteredAt: null,
    }]);
    paymentService.handleMidtransWebhook.mockRejectedValue(new Error('permanent failure'));

    await service.retryFailedWebhooks();

    expect(prisma.webhookLog.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        deadLetteredAt: expect.any(Date),
        nextRetryAt: null,
      }),
    }));
  });

  it('skips safely when Redis is unhealthy', async () => {
    redis.isHealthy.mockResolvedValue(false);

    await service.retryFailedWebhooks();

    expect(redis.setNx).not.toHaveBeenCalled();
    expect(prisma.webhookLog.findMany).not.toHaveBeenCalled();
  });
});
