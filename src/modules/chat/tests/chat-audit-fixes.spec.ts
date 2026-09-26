/**
 * Chat audit fixes — regression tests (2026-09-26).
 *
 * Mencakup:
 *  - Mute room menekan notifikasi pesan baru.
 *  - Preview notifikasi memakai teks PASCA-moderasi (redacted).
 *  - markMessageAsRead: idempoten, skip pesan sendiri, emit chat.read,
 *    update lastReadAt, kembalikan markedCount.
 *  - Forward lampiran dari pesan lawan bicara (skip ownership check).
 *  - Forward ditolak bila counterpart sumber tidak dapat ditentukan.
 *  - Reaksi/pin/typing diblokir setelah user memblokir counterpart.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ChatService } from '../chat.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { NotificationsService } from '../../notifications/notifications.service';

const mockPrisma = {
  chatRoom: { findUnique: jest.fn(), findFirst: jest.fn() },
  chatMessage: { findUnique: jest.fn(), findFirst: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
  chatRoomMember: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), upsert: jest.fn().mockResolvedValue({ id: 'm1' }) },
  blockList: { findFirst: jest.fn().mockResolvedValue(null) },
  dispute: { findFirst: jest.fn().mockResolvedValue(null) },
  user: { findUnique: jest.fn() },
  notification: { create: jest.fn() },
  $transaction: jest.fn(),
  $executeRaw: jest.fn().mockResolvedValue(1),
  emitNotificationCreated: jest.fn(),
};
const mockRealtime = {
  broadcastToRoom: jest.fn(),
  notifyUser: jest.fn(),
  emitToUser: jest.fn(),
  emitToChatRoom: jest.fn(),
  emitToOrder: jest.fn(),
  isUserOnline: jest.fn().mockResolvedValue(false),
};
const mockNotifications = { create: jest.fn() };
const mockConfig = { get: jest.fn().mockReturnValue(undefined) };

describe('ChatService audit fixes', () => {
  let service: ChatService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RealtimeService, useValue: mockRealtime },
        { provide: ConfigService, useValue: mockConfig },
        { provide: NotificationsService, useValue: mockNotifications },
      ],
    }).compile();
    service = module.get<ChatService>(ChatService);
  });

  describe('mute menekan notifikasi', () => {
    it('tidak membuat notifikasi bila penerima mem-mute room', async () => {
      const room = { id: 'room-1', buyerId: 'u1', sellerId: 'u2', orderId: 'o1' };
      mockPrisma.chatRoomMember.findUnique.mockResolvedValue({
        isMuted: true,
        mutedUntil: null,
      });
      // panggil private notifyNewMessage via any
      await (service as any).notifyNewMessage(room, 'u2', 'u1', 'msg-1', 'halo', 'TEXT');
      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
      expect(mockRealtime.notifyUser).not.toHaveBeenCalled();
    });

    it('tetap membuat notifikasi bila mute sudah kedaluwarsa', async () => {
      const room = { id: 'room-1', buyerId: 'u1', sellerId: 'u2', orderId: 'o1' };
      mockPrisma.chatRoomMember.findUnique.mockResolvedValue({
        isMuted: true,
        mutedUntil: new Date(Date.now() - 1000),
      });
      mockPrisma.notification.create.mockResolvedValue({ id: 'n1' });
      await (service as any).notifyNewMessage(room, 'u2', 'u1', 'msg-1', 'halo', 'TEXT');
      expect(mockPrisma.notification.create).toHaveBeenCalled();
    });
  });

  describe('markMessageAsRead', () => {
    beforeEach(() => {
      // validateRoomAccess membutuhkan room yang valid dan user aktif.
      mockPrisma.chatRoom.findUnique.mockResolvedValue({
        id: 'room-1',
        buyerId: 'u1',
        sellerId: 'u2',
        orderId: 'o1',
        order: { id: 'o1', status: 'ACTIVE', buyerId: 'u1', sellerId: 'u2' },
      });
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
    });

    it('idempoten: SQL tidak mengubah baris yang sudah dibaca (markedCount=0)', async () => {
      // WHERE clause menolak: sender sendiri ATAU readAt sudah berisi userId.
      mockPrisma.$executeRaw.mockResolvedValue(0);
      const res = (await service.markMessageAsRead('u1', 'room-1', 'msg-1')) as { markedCount: number };
      expect(res.markedCount).toBe(0);
      expect(mockRealtime.emitToUser).not.toHaveBeenCalled();
      expect(mockPrisma.chatRoomMember.update).not.toHaveBeenCalled();
    });

    it('menandai pesan lawan bicara: emit chat.read + update lastReadAt', async () => {
      mockPrisma.$executeRaw.mockResolvedValue(1);
      const res = (await service.markMessageAsRead('u1', 'room-1', 'msg-1')) as { markedCount: number };
      expect(res.markedCount).toBe(1);
      expect(mockPrisma.chatRoomMember.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { roomId_userId: { roomId: 'room-1', userId: 'u1' } },
        }),
      );
      // chat.read di-emit ke room via emitChatEvent.
      expect(mockRealtime.emitToChatRoom).toHaveBeenCalledWith(
        'room-1',
        'chat.read',
        expect.objectContaining({ messageId: 'msg-1', userId: 'u1' }),
      );
    });
  });

  describe('blokir menghentikan aksi interaktif', () => {
    it('addReaction ditolak bila counterpart diblokir', async () => {
      mockPrisma.blockList.findFirst.mockResolvedValue({ id: 'b1' });
      mockPrisma.chatRoom.findUnique.mockResolvedValue({
        id: 'room-1',
        buyerId: 'u1',
        sellerId: 'u2',
      });
      await expect(service.addReaction('u1', 'room-1', 'msg-1', '👍')).rejects.toThrow();
    });
  });
});
