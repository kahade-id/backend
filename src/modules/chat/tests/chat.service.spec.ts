import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatService } from '../chat.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { NotificationsService } from '../../notifications/notifications.service';

const mockPrisma = {
  chatRoom: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), update: jest.fn() },
  chatMessage: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  user: { findUnique: jest.fn() },
  blockList: { findFirst: jest.fn().mockResolvedValue(null) },
  notification: { create: jest.fn() },
  $transaction: jest.fn(),
};
const mockRealtime = { broadcastToRoom: jest.fn(), notifyUser: jest.fn(), emitToOrder: jest.fn(), emitToUser: jest.fn() };
const mockNotifications = { create: jest.fn() };
const mockConfig = {
  get: jest.fn((k: string) => {
    const v: Record<string, unknown> = {
      'r2.endpointUrl': 'https://r2.example.com',
      'r2.publicUrl': 'https://cdn.example.com',
    };
    return v[k];
  }),
};

describe('ChatService', () => {
  let service: ChatService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockPrisma.blockList.findFirst.mockResolvedValue(null);
    mockConfig.get.mockImplementation((k: string) => ({ 'r2.endpointUrl': 'https://r2.example.com', 'r2.publicUrl': 'https://cdn.example.com' } as Record<string, unknown>)[k]);
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

  describe('validateRoomAccess — cross-room authorization', () => {
    it('THROWS NotFoundException for nonexistent room', async () => {
      mockPrisma.chatRoom.findUnique.mockResolvedValue(null);
      await expect(service.validateRoomAccess('user-1', 'room-x')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('THROWS ForbiddenException when user is neither buyer nor seller', async () => {
      mockPrisma.chatRoom.findUnique.mockResolvedValue({
        id: 'room-1',
        order: { orderId: 'O1', buyerId: 'buyer', sellerId: 'seller', status: 'PROCESSING' },
      });
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
      await expect(service.validateRoomAccess('attacker', 'room-1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('THROWS ForbiddenException when user is banned', async () => {
      mockPrisma.chatRoom.findUnique.mockResolvedValue({
        id: 'room-1',
        order: { orderId: 'O1', buyerId: 'buyer', sellerId: 'seller', status: 'PROCESSING' },
      });
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: true });
      await expect(service.validateRoomAccess('buyer', 'room-1')).rejects.toMatchObject({
        response: { code: expect.stringMatching(/BANNED/) },
      });
    });

    it('THROWS ForbiddenException when user is inactive', async () => {
      mockPrisma.chatRoom.findUnique.mockResolvedValue({
        id: 'room-1',
        order: { orderId: 'O1', buyerId: 'buyer', sellerId: 'seller', status: 'PROCESSING' },
      });
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: false, isBanned: false });
      await expect(service.validateRoomAccess('buyer', 'room-1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('ALLOWS access for active buyer', async () => {
      mockPrisma.chatRoom.findUnique.mockResolvedValue({
        id: 'room-1',
        order: { orderId: 'O1', buyerId: 'buyer', sellerId: 'seller', status: 'PROCESSING' },
      });
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
      await expect(service.validateRoomAccess('buyer', 'room-1')).resolves.toBeDefined();
    });
  });

  describe('sendMessage — chat room closed grace period', () => {
    it('REJECTS send when order completed >24h ago', async () => {
      const completedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
      mockPrisma.chatRoom.findUnique.mockResolvedValue({
        id: 'room-1',
        order: { orderId: 'O1', buyerId: 'buyer', sellerId: 'seller', status: 'COMPLETED', completedAt, cancelledAt: null },
      });
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
      await expect(
        service.sendMessage('buyer', 'room-1', { content: 'hello', messageType: 'TEXT' } as never),
      ).rejects.toMatchObject({ response: { code: expect.stringMatching(/CLOSED/) } });
    });
  });

  describe('deleteMessage — ownership enforcement', () => {
    const room = {
      id: 'room-1',
      order: { orderId: 'O1', buyerId: 'buyer', sellerId: 'seller', status: 'PROCESSING' },
    };

    it('THROWS NotFoundException when message does not exist', async () => {
      mockPrisma.chatRoom.findUnique.mockResolvedValue(room);
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
      mockPrisma.chatMessage.findFirst.mockResolvedValue(null);
      await expect(service.deleteMessage('buyer', 'room-1', 'msg-x')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('THROWS ForbiddenException when deleting another user\'s message', async () => {
      mockPrisma.chatRoom.findUnique.mockResolvedValue(room);
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
      mockPrisma.chatMessage.findFirst.mockResolvedValue({ id: 'msg-1', roomId: 'room-1', senderId: 'seller' });
      await expect(service.deleteMessage('buyer', 'room-1', 'msg-1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('SOFT-DELETES own message and clears content', async () => {
      mockPrisma.chatRoom.findUnique
        .mockResolvedValueOnce(room)
        .mockResolvedValueOnce({ order: { orderId: 'O1' } });
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
      mockPrisma.chatMessage.findFirst.mockResolvedValue({ id: 'msg-1', roomId: 'room-1', senderId: 'buyer' });
      mockPrisma.chatMessage.update.mockResolvedValue({});
      await expect(service.deleteMessage('buyer', 'room-1', 'msg-1')).resolves.toEqual({ message: 'Message deleted successfully' });
      expect(mockPrisma.chatMessage.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'msg-1' },
        data: expect.objectContaining({ isDeleted: true, content: null }),
      }));
    });
  });

  /*
   * D-01 regression: the emit addressed `ChatRoom.orderId` — the relation FK holding the
   * internal cuid — while every socket room is named after the public `Order.orderId`
   * (`realtime.gateway.ts:421`, :478). The event went to a room nobody had joined, so the
   * counterpart's client never learned the message was deleted.
   *
   * The fixtures below deliberately give the two ids DIFFERENT values; the pre-existing test
   * above used `orderId: 'O1'` for both, which is why it could not catch this.
   */
  describe('deleteMessage — emits to the public order id (D-01)', () => {
    const ROOM_ACCESS = {
      id: 'room-1',
      order: { orderId: 'ORD-2026-0007', buyerId: 'buyer', sellerId: 'seller', status: 'PROCESSING' },
    };

    function arrange() {
      mockPrisma.chatRoom.findUnique
        .mockResolvedValueOnce(ROOM_ACCESS)
        // What the D-01 select returns: the public id nested under `order`, never the cuid.
        .mockResolvedValueOnce({ order: { orderId: 'ORD-2026-0007' } });
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
      mockPrisma.chatMessage.findFirst.mockResolvedValue({ id: 'msg-1', roomId: 'room-1', senderId: 'buyer' });
      mockPrisma.chatMessage.update.mockResolvedValue({});
    }

    it('addresses the room by public orderId, not the internal cuid', async () => {
      arrange();

      await service.deleteMessage('buyer', 'room-1', 'msg-1');

      expect(mockRealtime.emitToOrder).toHaveBeenCalledWith(
        'ORD-2026-0007',
        'chat.message_deleted',
        { messageId: 'msg-1', roomId: 'room-1' },
      );
      // Pre-fix this was 'ckroom1cuid0000' — a room name no client ever joins.
      expect(mockRealtime.emitToOrder).not.toHaveBeenCalledWith(
        'ckroom1cuid0000',
        expect.anything(),
        expect.anything(),
      );
    });

    it('selects the public id through the order relation', async () => {
      arrange();

      await service.deleteMessage('buyer', 'room-1', 'msg-1');

      expect(mockPrisma.chatRoom.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'room-1', deletedAt: null } }));
    });

    it('soft-deletes and emits using the authorized room without a second lookup', async () => {
      mockPrisma.chatRoom.findUnique.mockResolvedValueOnce(ROOM_ACCESS);
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
      mockPrisma.chatMessage.findFirst.mockResolvedValue({ id: 'msg-1', roomId: 'room-1', senderId: 'buyer' });
      mockPrisma.chatMessage.update.mockResolvedValue({});

      await expect(service.deleteMessage('buyer', 'room-1', 'msg-1')).resolves.toEqual({ message: 'Message deleted successfully' });
      expect(mockPrisma.chatMessage.update).toHaveBeenCalled();
      expect(mockRealtime.emitToOrder).toHaveBeenCalledWith('ORD-2026-0007', 'chat.message_deleted', { messageId: 'msg-1', roomId: 'room-1' });
    });
  });

  describe('sendMessage — attachment MIME validation', () => {
    const room = {
      id: 'room-1',
      order: { orderId: 'O1', buyerId: 'buyer', sellerId: 'seller', status: 'PROCESSING' },
    };

    it('REJECTS attachments with disallowed MIME type (e.g. application/x-msdownload)', async () => {
      // fileUrl uses the trusted r2.endpointUrl hostname configured in mockConfig
      // and embeds the senderId in the path so storage + ownership checks pass,
      // forcing execution to reach the MIME allowlist branch.
      mockPrisma.chatRoom.findUnique.mockResolvedValue(room);
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
      await expect(
        service.sendMessage('buyer', 'room-1', {
          content: 'malicious',
          messageType: 'IMAGE',
          attachments: [
            {
              fileName: 'evil.exe',
              fileSize: 1024,
              mimeType: 'application/x-msdownload',
              fileUrl: 'https://r2.example.com/uploads/chat-attachments/buyer/evil.exe',
            },
          ],
        } as never),
      ).rejects.toMatchObject({
        response: {
          code: 'VALIDATION_ERROR',
          message: expect.stringMatching(/MIME type/i),
        },
      });
    });

    it('ACCEPTS attachments whose URL is on the trusted storage host but REJECTS off-host', async () => {
      mockPrisma.chatRoom.findUnique.mockResolvedValue(room);
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
      await expect(
        service.sendMessage('buyer', 'room-1', {
          content: 'phish',
          messageType: 'IMAGE',
          attachments: [
            {
              fileName: 'photo.jpg',
              fileSize: 1024,
              mimeType: 'image/jpeg',
              fileUrl: 'https://attacker.example/photo.jpg',
            },
          ],
        } as never),
      ).rejects.toMatchObject({
        response: {
          code: 'VALIDATION_ERROR',
          message: expect.stringMatching(/platform storage/i),
        },
      });
    });
  });

  void BadRequestException;
});
