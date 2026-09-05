import { AdminSystemService } from '../admin-system.service';

describe('AdminSystemService broadcast push delivery', () => {
  const prisma = {
    user: { findMany: jest.fn() },
    notification: { createMany: jest.fn() },
  };
  const redis = { set: jest.fn() };
  const auditLogService = { logAdminAction: jest.fn() };
  const notificationQueue = { enqueueMany: jest.fn() };
  let service: AdminSystemService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findMany.mockResolvedValueOnce([{ id: 'user-1' }, { id: 'user-2' }]);
    notificationQueue.enqueueMany.mockImplementation(async (jobs: unknown[]) => jobs.length);
    service = new AdminSystemService(
      prisma as never,
      redis as never,
      auditLogService as never,
      notificationQueue as never,
    );
  });

  it('queues native push jobs and lets the worker persist the notification once', async () => {
    const result = await service.sendBroadcast({
      title: 'Pengumuman Kahade',
      body: 'Ada pembaruan penting untuk Anda',
      channels: ['push'],
      targetAudience: 'all',
    }, 'admin-1', '127.0.0.1');

    expect(notificationQueue.enqueueMany).toHaveBeenCalledWith([
      expect.objectContaining({
        userId: 'user-1',
        channel: 'PUSH_NOTIFICATION',
        actionUrl: '/notifications',
        pushData: expect.objectContaining({
          notificationType: 'SYSTEM_ANNOUNCEMENT',
          notificationCategory: 'INFORMASI',
        }),
      }),
      expect.objectContaining({ userId: 'user-2' }),
    ]);
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ recipientCount: 2, queuedCount: 2, pushRequested: true });
  });

  it('queues push even when the admin also selects the in-app channel', async () => {
    const result = await service.sendBroadcast({
      title: 'Info',
      body: 'Pesan',
      channels: ['in_app', 'push'],
      targetAudience: 'all',
    }, 'admin-1', '127.0.0.1');

    expect(notificationQueue.enqueueMany).toHaveBeenCalledTimes(1);
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
    expect(result.pushRequested).toBe(true);
  });
});

