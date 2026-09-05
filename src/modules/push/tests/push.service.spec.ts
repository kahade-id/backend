import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PushService } from '../push.service';
import { PrismaService } from '../../../prisma/prisma.service';

jest.mock('firebase-admin', () => ({
  apps: [],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  messaging: jest.fn(),
}));

const mockPrisma = {
  notification: { findFirst: jest.fn(), update: jest.fn() },
  notificationPreference: { findUnique: jest.fn() },
  userDevice: { findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  onNotificationCreated: jest.fn(),
};
const mockConfig = { get: jest.fn() };

describe('PushService', () => {
  let service: PushService;
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    jest.resetAllMocks();
    originalFetch = global.fetch;
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PushService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    service = module.get<PushService>(PushService);
  });

  afterEach(() => { global.fetch = originalFetch; });

  it('should be defined', () => expect(service).toBeDefined());

  describe('onModuleInit', () => {
    it('warns and skips FCM when credentials missing', () => {
      mockConfig.get.mockReturnValue(undefined);
      expect(() => service.onModuleInit()).not.toThrow();
      expect(mockPrisma.onNotificationCreated).toHaveBeenCalled();
    });
  });

  describe('legacy payload enrichment', () => {
    it('adds public notification identity and canonical action URL from the persisted record', async () => {
      mockPrisma.notification.findFirst.mockResolvedValue({
        id: 'row-1',
        notifId: 'NTF-public-123',
        actionUrl: null,
        type: 'ORDER_NEW',
        category: 'TRANSAKSI',
      });
      mockPrisma.notification.update.mockResolvedValue({});

      const data = await (service as any).enrichPushData('user-1', 'Pesanan baru', 'Ada pesanan baru.', { type: 'ORDER_NEW', orderId: 'ORD-20260819-000001-OMXX' });

      expect(data).toMatchObject({
        notificationId: 'NTF-public-123',
        actionUrl: '/order/ORD-20260819-000001-OMXX',
        notificationType: 'ORDER_NEW',
      });
      expect(mockPrisma.notification.update).toHaveBeenCalledWith({
        where: { id: 'row-1' },
        data: { actionUrl: '/order/ORD-20260819-000001-OMXX' },
      });
      expect(mockPrisma.notification.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ OR: expect.arrayContaining([{ type: 'ORDER_NEW' }]) }),
      }));
    });

    it('derives an order action URL when a legacy event has no stored action URL', async () => {
      mockPrisma.notification.findFirst.mockResolvedValue(null);

      const data = await (service as any).enrichPushData('user-1', 'Pesanan baru', 'Ada pesanan baru.', { orderId: 'ORD-20260819-000001-OMXX' });

      expect(data.actionUrl).toBe('/order/ORD-20260819-000001-OMXX');
    });

    it('normalizes legacy event aliases before matching their durable inbox record', async () => {
      mockPrisma.notification.findFirst.mockResolvedValue({
        id: 'row-chat-1', notifId: 'NTF-chat-1', actionUrl: '/chat/ROOM-1', type: 'CHAT_NEW_MESSAGE', category: 'INFORMASI',
      });

      const data = await (service as any).enrichPushData('user-1', 'Pesan baru', 'Halo', { type: 'CHAT_NEW', roomId: 'ROOM-1' });

      expect(mockPrisma.notification.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ OR: expect.arrayContaining([{ type: 'CHAT_NEW_MESSAGE' }]) }),
      }));
      expect(data).toMatchObject({ notificationId: 'NTF-chat-1', notificationType: 'CHAT_NEW_MESSAGE', actionUrl: '/chat/ROOM-1' });
    });
  });

  describe('sendToUser - preferences', () => {
    it('skips when preference disabled for type', async () => {
      mockPrisma.notificationPreference.findUnique.mockResolvedValue({ orderPush: false });
      await service.sendToUser('u1', 'T', 'B', { notificationType: 'ORDER_CREATED' });
      expect(mockPrisma.userDevice.findMany).not.toHaveBeenCalled();
    });

    it('fails closed for opted-in categories when preference lookup is unavailable', async () => {
      mockPrisma.notificationPreference.findUnique.mockRejectedValue(new Error('database unavailable'));
      await service.sendToUser('u1', 'T', 'B', { notificationType: 'WALLET_TOPUP_SUCCESS' });
      expect(mockPrisma.userDevice.findMany).not.toHaveBeenCalled();
    });

    it('proceeds when no notificationType prefix matches', async () => {
      mockPrisma.userDevice.findMany.mockResolvedValue([]);
      await service.sendToUser('u1', 'T', 'B', {});
      expect(mockPrisma.userDevice.findMany).toHaveBeenCalled();
    });

    it('does not send native iOS APNs tokens through FCM', async () => {
      mockPrisma.userDevice.findMany.mockResolvedValue([{ id: 'ios-1', pushToken: 'apns-native-token', deviceType: 'ios' }]);
      global.fetch = jest.fn() as any;

      await service.sendToUser('u1', 'T', 'B');

      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockPrisma.userDevice.updateMany).not.toHaveBeenCalled();
    });

    it('returns silently when no devices', async () => {
      mockPrisma.userDevice.findMany.mockResolvedValue([]);
      await service.sendToUser('u1', 'T', 'B');
      expect(mockPrisma.userDevice.findMany).toHaveBeenCalled();
    });
  });

  describe('sendToUser - Expo path', () => {
    it('calls Expo API for Expo tokens', async () => {
      mockPrisma.notificationPreference.findUnique.mockResolvedValue({ orderPush: true });
      mockPrisma.userDevice.findMany.mockResolvedValue([
        { id: 'd1', pushToken: 'ExponentPushToken[abc]' },
      ]);
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ status: 'ok' }] }),
      });
      global.fetch = fetchMock as any;
      await service.sendToUser('u1', 'T', 'B', { notificationType: 'ORDER_CREATED' });
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('exp.host'), expect.any(Object));
    });

    it.each([
      ['SECURITY_NEW_LOGIN', 'security'],
      ['ORDER_DELIVERED', 'orders'],
      ['WALLET_TOPUP_SUCCESS', 'wallet'],
      ['CHAT_NEW_MESSAGE', 'chat'],
    ])('routes %s to the %s Android channel', async (notificationType, expectedChannelId) => {
      mockPrisma.notificationPreference.findUnique.mockResolvedValue({ securityPush: true, orderPush: true, walletPush: true, chatPush: true });
      mockPrisma.userDevice.findMany.mockResolvedValue([{ id: 'd1', pushToken: 'ExpoPushToken[channel]' }]);
      const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ status: 'ok' }] }) });
      global.fetch = fetchMock as any;

      await service.sendToUser('u1', 'T', 'B', { notificationType });

      const sent = JSON.parse(fetchMock.mock.calls[0][1].body)[0];
      expect(sent.channelId).toBe(expectedChannelId);
    });

    it('splits delivery into Expo-safe batches when a user has more than 100 devices', async () => {
      mockPrisma.userDevice.findMany.mockResolvedValue(Array.from({ length: 101 }, (_, index) => ({ id: `d${index}`, pushToken: `ExpoPushToken[token${index}]` })));
      const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: Array.from({ length: 100 }, () => ({ status: 'ok' })) }) });
      global.fetch = fetchMock as any;

      await service.sendToUser('u1', 'T', 'B');

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const firstBatch = JSON.parse(fetchMock.mock.calls[0][1].body);
      const secondBatch = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(firstBatch).toHaveLength(100);
      expect(secondBatch).toHaveLength(1);
    });

    it('strips unknown or oversized metadata before sending push data to a device', async () => {
      mockPrisma.userDevice.findMany.mockResolvedValue([{ id: 'd1', pushToken: 'ExpoPushToken[privacy]' }]);
      const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ status: 'ok' }] }) });
      global.fetch = fetchMock as any;

      await service.sendToUser('u1', 'T', 'B', { notificationType: 'ORDER_NEW', orderId: 'ORD-1', email: 'private@example.com', payload: 'x'.repeat(10_000) });

      const sent = JSON.parse(fetchMock.mock.calls[0][1].body)[0].data;
      expect(sent).toEqual({ notificationType: 'ORDER_NEW', orderId: 'ORD-1' });
    });

    it('clears invalid Expo token on DeviceNotRegistered', async () => {
      mockPrisma.userDevice.findMany.mockResolvedValue([
        { id: 'd1', pushToken: 'ExpoPushToken[xyz]' },
      ]);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }] }),
      }) as any;
      mockPrisma.userDevice.update.mockResolvedValue({});
      await service.sendToUser('u1', 'T', 'B');
      expect(mockPrisma.userDevice.update).toHaveBeenCalledWith({
        where: { id: 'd1' }, data: { pushToken: null },
      });
    });

    it('handles non-OK Expo response without throwing', async () => {
      mockPrisma.userDevice.findMany.mockResolvedValue([
        { id: 'd1', pushToken: 'ExpoPushToken[xyz]' },
      ]);
      global.fetch = jest.fn().mockResolvedValue({
        ok: false, status: 500, text: async () => 'err',
      }) as any;
      await expect(service.sendToUser('u1', 'T', 'B')).resolves.toBeUndefined();
    });
  });

  describe('sendToMultipleUsers', () => {
    it('runs allSettled across users', async () => {
      mockPrisma.userDevice.findMany.mockResolvedValue([]);
      await service.sendToMultipleUsers(['u1', 'u2'], 'T', 'B');
      expect(mockPrisma.userDevice.findMany).toHaveBeenCalledTimes(2);
    });
  });
});
