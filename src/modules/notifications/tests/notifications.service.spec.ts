import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { NotificationsService } from '../notifications.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { NotificationType, NotificationCategory } from '@prisma/client';

const mockPrisma = {
  notification: {
    findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(),
    findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(),
    groupBy: jest.fn(),
  },
  notificationPreference: { upsert: jest.fn(), findUnique: jest.fn() },
  userDevice: { updateMany: jest.fn(), findFirst: jest.fn(), update: jest.fn(), create: jest.fn(), upsert: jest.fn() },
};

describe('NotificationsService', () => {
  let service: NotificationsService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockPrisma.notificationPreference.findUnique.mockResolvedValue(null);
    const module: TestingModule = await Test.createTestingModule({
      providers: [NotificationsService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get<NotificationsService>(NotificationsService);
  });

  it('should be defined', () => expect(service).toBeDefined());

  describe('isDuplicate', () => {
    it('returns true when recent matching notif exists', async () => {
      mockPrisma.notification.findFirst.mockResolvedValue({ id: 'n1' });
      const res = await service.isDuplicate('u1', NotificationType.ORDER_ACCEPTED, 'body');
      expect(res).toBe(true);
    });

    it('returns false when no match', async () => {
      mockPrisma.notification.findFirst.mockResolvedValue(null);
      const res = await service.isDuplicate('u1', NotificationType.ORDER_ACCEPTED, 'body');
      expect(res).toBe(false);
    });
  });

  describe('isDuplicateByRef', () => {
    it('returns true when recent ref match', async () => {
      mockPrisma.notification.findFirst.mockResolvedValue({ id: 'n1' });
      const res = await service.isDuplicateByRef('u1', NotificationType.ORDER_ACCEPTED, 'ref-1');
      expect(res).toBe(true);
    });
  });

  describe('listNotifications', () => {
    it('returns paginated list with safe page/limit', async () => {
      mockPrisma.notification.findMany.mockResolvedValue([]);
      mockPrisma.notification.count.mockResolvedValue(0);
      await service.listNotifications('u1', 0, 999);
      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 100 }));
    });

    it('filters by isRead and category', async () => {
      mockPrisma.notification.findMany.mockResolvedValue([]);
      mockPrisma.notification.count.mockResolvedValue(0);
      await service.listNotifications('u1', 1, 10, false, NotificationCategory.TRANSAKSI);
      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ isRead: false, category: NotificationCategory.TRANSAKSI }),
      }));
    });
  });

  describe('getNotification', () => {
    it('returns only the owned active public notification record', async () => {
      mockPrisma.notification.findFirst.mockResolvedValue({ notifId: 'NTF-public-1', title: 'Aman', isRead: false });

      const result = await service.getNotification('u1', 'NTF-public-1');

      expect(result).toMatchObject({ notifId: 'NTF-public-1', title: 'Aman' });
      expect(mockPrisma.notification.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ userId: 'u1', notifId: 'NTF-public-1', deletedAt: null }),
      }));
    });

    it('does not reveal a missing or foreign notification', async () => {
      mockPrisma.notification.findFirst.mockResolvedValue(null);

      await expect(service.getNotification('u1', 'NTF-public-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getUnreadCount', () => {
    it('returns single category count', async () => {
      mockPrisma.notification.count.mockResolvedValue(7);
      const res = await service.getUnreadCount('u1', NotificationCategory.TRANSAKSI);
      expect(res.unreadCount).toBe(7);
    });

    it('aggregates per-category counts', async () => {
      mockPrisma.notification.groupBy.mockResolvedValue([
        { category: NotificationCategory.INFORMASI, _count: { _all: 2 } },
        { category: NotificationCategory.TRANSAKSI, _count: { _all: 5 } },
      ]);
      const res = await service.getUnreadCount('u1');
      expect(res.unreadCount).toBe(7);
      expect(res.perCategory?.TRANSAKSI).toBe(5);
    });
  });

  describe('markAsRead', () => {
    it('marks owned notif as read', async () => {
      mockPrisma.notification.findUnique.mockResolvedValue({ id: 'n1', notifId: 'nid', userId: 'u1', deletedAt: null });
      mockPrisma.notification.update.mockResolvedValue({ id: 'n1', isRead: true });
      const res = await service.markAsRead('u1', 'nid');
      expect((res as any).isRead).toBe(true);
    });

    it('throws NotFoundException when missing', async () => {
      mockPrisma.notification.findUnique.mockResolvedValue(null);
      await expect(service.markAsRead('u1', 'nid')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when soft-deleted', async () => {
      mockPrisma.notification.findUnique.mockResolvedValue({ id: 'n1', userId: 'u1', deletedAt: new Date() });
      await expect(service.markAsRead('u1', 'nid')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when expired', async () => {
      mockPrisma.notification.findUnique.mockResolvedValue({ id: 'n1', userId: 'u1', deletedAt: null, expiresAt: new Date('2020-01-01T00:00:00Z') });
      await expect(service.markAsRead('u1', 'nid')).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when not owner', async () => {
      mockPrisma.notification.findUnique.mockResolvedValue({ id: 'n1', userId: 'other', deletedAt: null });
      await expect(service.markAsRead('u1', 'nid')).rejects.toThrow(ForbiddenException);
    });
  });

  describe('markBatchAsRead', () => {
    it('updates only owned unread', async () => {
      mockPrisma.notification.updateMany.mockResolvedValue({ count: 3 });
      const res = await service.markBatchAsRead('u1', ['n1', 'n2', 'n3']);
      expect(res.markedCount).toBe(3);
    });
  });

  describe('deleteBatch', () => {
    it('soft-deletes owned notifs', async () => {
      mockPrisma.notification.updateMany.mockResolvedValue({ count: 2 });
      const res = await service.deleteBatch('u1', ['n1', 'n2']);
      expect(res.deletedCount).toBe(2);
    });
  });

  describe('deleteAllRead', () => {
    it('soft-deletes only the current user’s read notifications across every page', async () => {
      mockPrisma.notification.updateMany.mockResolvedValue({ count: 4 });

      const result = await service.deleteAllRead('u1');

      expect(result.deletedCount).toBe(4);
      expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { userId: 'u1', isRead: true, deletedAt: null },
      }));
    });
  });

  describe('markAllAsRead', () => {
    it('processes batches until empty', async () => {
      mockPrisma.notification.findMany.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }])
        .mockResolvedValueOnce([]);
      mockPrisma.notification.updateMany.mockResolvedValue({ count: 2 });
      const res = await service.markAllAsRead('u1');
      expect(res.markedCount).toBe(2);
    });
  });

  describe('getPreferences/updatePreferences', () => {
    it('upserts preferences', async () => {
      mockPrisma.notificationPreference.upsert.mockResolvedValue({ userId: 'u1' });
      await service.getPreferences('u1');
      expect(mockPrisma.notificationPreference.upsert).toHaveBeenCalled();
    });

    it('updates preferences with provided data', async () => {
      mockPrisma.notificationPreference.upsert.mockResolvedValue({ userId: 'u1', orderPush: false });
      await service.updatePreferences('u1', { orderPush: false } as any);
      expect(mockPrisma.notificationPreference.upsert).toHaveBeenCalled();
    });
  });

  describe('deleteNotification', () => {
    it('soft-deletes owned notification', async () => {
      mockPrisma.notification.findUnique.mockResolvedValue({ id: 'n1', userId: 'u1', deletedAt: null });
      mockPrisma.notification.update.mockResolvedValue({});
      const res = await service.deleteNotification('u1', 'nid');
      expect(res.message).toContain('deleted');
    });

    it('throws ForbiddenException when not owner', async () => {
      mockPrisma.notification.findUnique.mockResolvedValue({ id: 'n1', userId: 'other', deletedAt: null });
      await expect(service.deleteNotification('u1', 'nid')).rejects.toThrow(ForbiddenException);
    });
  });

  describe('registerDevice', () => {
    it('throws BadRequestException for invalid token', async () => {
      await expect(service.registerDevice('u1', 'bad')).rejects.toThrow(BadRequestException);
    });

    it('refreshes existing-by-token entry', async () => {
      mockPrisma.userDevice.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.userDevice.findFirst.mockResolvedValueOnce({ id: 'd1' });
      mockPrisma.userDevice.update.mockResolvedValue({});
      const res = await service.registerDevice('u1', 'ExponentPushToken[abcdefghij]', 'ios');
      expect(res.deviceId).toBe('d1');
      expect(res.message).toContain('updated');
    });

    it('rotates token on existing-by-platform device', async () => {
      mockPrisma.userDevice.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.userDevice.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'd2' });
      mockPrisma.userDevice.update.mockResolvedValue({});
      const res = await service.registerDevice('u1', 'ExponentPushToken[1234567890]', 'android');
      expect(res.deviceId).toBe('d2');
      expect(res.message).toContain('refreshed');
    });

    it('creates new device when no match', async () => {
      mockPrisma.userDevice.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.userDevice.findFirst.mockResolvedValue(null);
      mockPrisma.userDevice.create.mockResolvedValue({ id: 'd3' });
      const res = await service.registerDevice('u1', 'ExponentPushToken[1234567890]', 'android', '1.2.3.4');
      expect(res.deviceId).toBe('d3');
    });

    /*
     * D-04: registration used to invent a synthetic `push-<platform>-<nanoid>` device id and
     * ignore the fingerprint the client actually sends. Two consequences, both silent:
     *
     *   1. `unregisterDevice` looks the row up BY that fingerprint, so on logout its updateMany
     *      matched 0 rows, returned "unregistered successfully", and left the token live.
     *   2. The fallback matched on `deviceType` alone, so a user's second Android install
     *      overwrote the first one's token instead of getting its own row.
     *
     * Keying on `@@unique([userId, deviceId])` fixes both and is race-safe as an upsert.
     */
    it('upserts on the (userId, deviceId) unique key when the client sends a fingerprint', async () => {
      mockPrisma.userDevice.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.userDevice.upsert.mockResolvedValue({ id: 'd-real' });

      const res = await service.registerDevice(
        'u1', 'ExponentPushToken[1234567890]', 'android', '1.2.3.4', 'fp-device-aaa',
      );

      expect(res.deviceId).toBe('d-real');
      expect(mockPrisma.userDevice.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId_deviceId: { userId: 'u1', deviceId: 'fp-device-aaa' } },
        }),
      );
      // The synthetic-id create path must not run — that id is what unregister could never find.
      expect(mockPrisma.userDevice.create).not.toHaveBeenCalled();
    });

    it('stores the client fingerprint verbatim, never a generated push-* id', async () => {
      mockPrisma.userDevice.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.userDevice.upsert.mockResolvedValue({ id: 'd-real' });

      await service.registerDevice('u1', 'ExponentPushToken[1234567890]', 'ios', '1.2.3.4', 'fp-device-bbb');

      const arg = mockPrisma.userDevice.upsert.mock.calls[0][0];
      expect(arg.create.deviceId).toBe('fp-device-bbb');
      expect(arg.create.deviceId).not.toMatch(/^push-/);
      expect(arg.update.pushToken).toBe('ExponentPushToken[1234567890]');
    });

    it('keeps two same-platform devices apart instead of evicting the first', async () => {
      mockPrisma.userDevice.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.userDevice.upsert
        .mockResolvedValueOnce({ id: 'phone' })
        .mockResolvedValueOnce({ id: 'tablet' });

      const phone = await service.registerDevice('u1', 'ExponentPushToken[phone00000]', 'android', '1.2.3.4', 'fp-phone');
      const tablet = await service.registerDevice('u1', 'ExponentPushToken[tablet0000]', 'android', '1.2.3.4', 'fp-tablet');

      expect(phone.deviceId).toBe('phone');
      expect(tablet.deviceId).toBe('tablet');
      // Pre-fix the second call matched the first by `deviceType: 'android'` and overwrote it,
      // so the phone stopped receiving push the moment the tablet registered.
      const keys = mockPrisma.userDevice.upsert.mock.calls.map((c) => c[0].where.userId_deviceId.deviceId);
      expect(keys).toEqual(['fp-phone', 'fp-tablet']);
    });

    it('still falls back to the legacy path when no fingerprint is sent', async () => {
      mockPrisma.userDevice.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.userDevice.findFirst.mockResolvedValue(null);
      mockPrisma.userDevice.create.mockResolvedValue({ id: 'd-legacy' });

      const res = await service.registerDevice('u1', 'ExponentPushToken[1234567890]', 'android', '1.2.3.4');

      expect(res.deviceId).toBe('d-legacy');
      expect(mockPrisma.userDevice.upsert).not.toHaveBeenCalled();
    });

    it('still evicts the token from another user before registering it', async () => {
      mockPrisma.userDevice.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.userDevice.upsert.mockResolvedValue({ id: 'd-real' });

      await service.registerDevice('u1', 'ExponentPushToken[1234567890]', 'android', '1.2.3.4', 'fp-device-ccc');

      // A token reassigned to a new account must stop delivering to the old one.
      expect(mockPrisma.userDevice.updateMany).toHaveBeenCalledWith({
        where: { pushToken: 'ExponentPushToken[1234567890]', userId: { not: 'u1' } },
        data: { pushToken: null },
      });
    });
  });

  describe('unregisterDevice', () => {
    it('clears token by deviceId', async () => {
      mockPrisma.userDevice.updateMany.mockResolvedValue({ count: 1 });
      const res = await service.unregisterDevice('u1', 'dev-id-1');
      expect(res.message).toContain('unregistered');
    });

    it('throws BadRequestException when missing deviceId', async () => {
      await expect(service.unregisterDevice('u1', '')).rejects.toThrow(BadRequestException);
    });
  });
});
