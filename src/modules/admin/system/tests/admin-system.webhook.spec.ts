import { BadRequestException } from '@nestjs/common';
import { AdminSystemService } from '../admin-system.service';

describe('AdminSystemService webhook dead-letter actions', () => {
  const prisma = {
    webhookLog: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
  };
  const redis = {};
  const auditLogService = {
    logAdminAction: jest.fn(),
  };

  let service: AdminSystemService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.webhookLog.updateMany.mockResolvedValue({ count: 1 });
    service = new AdminSystemService(prisma as never, redis as never, auditLogService as never, { enqueueMany: jest.fn() } as never);
  });

  it('requeues an unprocessed dead-letter event and resets the retry budget', async () => {
    prisma.webhookLog.findUnique.mockResolvedValue({
      id: 'cldeadletter12345678901234',
      isProcessed: false,
      retryCount: 5,
      deadLetteredAt: new Date('2026-01-01T00:00:00Z'),
      errorMessage: 'permanent failure',
    });

    await expect(service.retryDeadLetterWebhook('cldeadletter12345678901234', 'admin-1', '127.0.0.1'))
      .resolves.toMatchObject({ status: 'queued' });

    expect(prisma.webhookLog.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'cldeadletter12345678901234', isProcessed: false },
      data: expect.objectContaining({ retryCount: 0, deadLetteredAt: null, nextRetryAt: expect.any(Date) }),
    }));
    expect(auditLogService.logAdminAction).toHaveBeenCalledWith(expect.objectContaining({
      targetType: 'WebhookLog',
      targetId: 'cldeadletter12345678901234',
    }));
  });

  it('resolves an unprocessed event with a bounded manual note', async () => {
    prisma.webhookLog.findUnique.mockResolvedValue({
      id: 'cldeadletter12345678901234',
      isProcessed: false,
      retryCount: 5,
      deadLetteredAt: new Date(),
      errorMessage: 'permanent failure',
    });

    await expect(service.resolveDeadLetterWebhook('cldeadletter12345678901234', 'admin-1', '127.0.0.1', 'Reviewed by finance'))
      .resolves.toMatchObject({ status: 'resolved' });

    expect(prisma.webhookLog.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        deadLetteredAt: expect.any(Date),
        nextRetryAt: null,
        errorMessage: 'MANUAL_RESOLUTION: Reviewed by finance',
      }),
    }));
  });

  it('rejects retry of an event that is not dead-lettered', async () => {
    prisma.webhookLog.findUnique.mockResolvedValue({ id: 'clactive123456789012345678', isProcessed: false, deadLetteredAt: null, errorMessage: 'transient failure' });

    await expect(service.retryDeadLetterWebhook('clactive123456789012345678', 'admin-1', '127.0.0.1'))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.webhookLog.updateMany).not.toHaveBeenCalled();
  });

  it('rejects retry of a manually resolved event', async () => {
    prisma.webhookLog.findUnique.mockResolvedValue({ id: 'clresolved12345678901234', isProcessed: false, deadLetteredAt: new Date(), errorMessage: 'MANUAL_RESOLUTION: already reviewed' });

    await expect(service.retryDeadLetterWebhook('clresolved12345678901234', 'admin-1', '127.0.0.1'))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.webhookLog.updateMany).not.toHaveBeenCalled();
  });

  it('rejects resolving an event that is not dead-lettered', async () => {
    prisma.webhookLog.findUnique.mockResolvedValue({ id: 'clactive123456789012345678', isProcessed: false, deadLetteredAt: null, errorMessage: 'transient failure' });

    await expect(service.resolveDeadLetterWebhook('clactive123456789012345678', 'admin-1', '127.0.0.1', 'Reviewed'))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.webhookLog.updateMany).not.toHaveBeenCalled();
  });

  it('rejects resolving a manually resolved event', async () => {
    prisma.webhookLog.findUnique.mockResolvedValue({ id: 'clresolved12345678901234', isProcessed: false, deadLetteredAt: new Date(), errorMessage: 'MANUAL_RESOLUTION: already reviewed' });

    await expect(service.resolveDeadLetterWebhook('clresolved12345678901234', 'admin-1', '127.0.0.1', 'Reviewed again'))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.webhookLog.updateMany).not.toHaveBeenCalled();
  });

  it('rejects retry of an already processed event', async () => {
    prisma.webhookLog.findUnique.mockResolvedValue({ id: 'cldeadletter12345678901234', isProcessed: true });

    await expect(service.retryDeadLetterWebhook('cldeadletter12345678901234', 'admin-1', '127.0.0.1'))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.webhookLog.updateMany).not.toHaveBeenCalled();
  });
});
