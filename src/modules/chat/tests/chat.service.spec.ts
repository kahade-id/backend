import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatService } from '../chat.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { NotificationsService } from '../../notifications/notifications.service';

const mockPrisma = {
  chatRoom: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  chatMessage: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  chatMessageReaction: {
    findMany: jest.fn(),
    upsert: jest.fn(),
    deleteMany: jest.fn(),
  },
  chatMessageEdit: { create: jest.fn() },
  chatRoomMember: {
    upsert: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
  },
  chatModerationEvent: { create: jest.fn() },
  chatAttachment: { findMany: jest.fn(), count: jest.fn() },
  blockList: { findFirst: jest.fn().mockResolvedValue(null) },
  dispute: { findFirst: jest.fn().mockResolvedValue(null) },
  user: { findUnique: jest.fn(), findMany: jest.fn() },
  notification: { create: jest.fn() },
  $transaction: jest.fn(),
  emitNotificationCreated: jest.fn(),
};
const mockRealtime = {
  broadcastToRoom: jest.fn(),
  notifyUser: jest.fn(),
  emitToOrder: jest.fn(),
  emitToUser: jest.fn(),
  emitToChatRoom: jest.fn(),
  areUsersOnline: jest.fn().mockResolvedValue({}),
  isUserOnline: jest.fn().mockResolvedValue(false),
  getLastSeen: jest.fn().mockResolvedValue(null),
};
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

/** Bentuk minimal yang dibutuhkan `serializeMessage`. */
function messageFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    roomId: 'room-1',
    messageType: 'TEXT',
    content: 'hello',
    isEdited: false,
    editedAt: null,
    isDeleted: false,
    deletedAt: null,
    isPinned: false,
    pinnedAt: null,
    durationSeconds: null,
    forwardedFromId: null,
    readAt: null,
    createdAt: new Date('2026-09-13T00:00:00Z'),
    updatedAt: new Date('2026-09-13T00:00:00Z'),
    replyToId: null,
    replyTo: null,
    forwardedFrom: null,
    sender: { id: 'buyer', userId: 'buyer', fullName: 'Buyer', avatarUrl: null },
    attachments: [],
    reactions: [],
    ...overrides,
  };
}

const ROOM = {
  id: 'room-1',
  type: 'ORDER',
  status: 'ACTIVE',
  subject: null,
  initiatorId: 'buyer',
  counterpartId: 'seller',
  order: {
    id: 'order-cuid-1',
    orderId: 'ORD-2026-0007',
    status: 'PROCESSING',
    completedAt: null,
    cancelledAt: null,
    buyerId: 'buyer',
    sellerId: 'seller',
    deletedAt: null,
  },
};

describe('ChatService', () => {
  let service: ChatService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockPrisma.blockList.findFirst.mockResolvedValue(null);
    mockPrisma.dispute.findFirst.mockResolvedValue(null);
    mockPrisma.user.findMany.mockResolvedValue([]);
    mockPrisma.chatMessageReaction.findMany.mockResolvedValue([]);
    mockPrisma.chatRoomMember.findMany.mockResolvedValue([]);
    mockPrisma.chatRoomMember.upsert.mockResolvedValue({ id: 'member-1' });
    mockPrisma.chatRoomMember.update.mockResolvedValue({ id: 'member-1' });
    mockPrisma.chatRoom.update.mockResolvedValue({});
    mockPrisma.chatRoom.count.mockResolvedValue(0);
    mockPrisma.chatMessage.count.mockResolvedValue(0);
    mockPrisma.chatModerationEvent.create.mockResolvedValue({ id: 'cme-1' });
    mockPrisma.chatMessageEdit.create.mockResolvedValue({ id: 'edit-1' });
    mockPrisma.notification.create.mockResolvedValue({ notifId: 'notif-1' });
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
      await expect(service.validateRoomAccess('buyer', 'room-1')).rejects.toBeInstanceOf(ForbiddenException);
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
      mockPrisma.chatRoom.findUnique.mockResolvedValue(ROOM);
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
      await expect(service.validateRoomAccess('buyer', 'room-1')).resolves.toBeDefined();
    });

    it('AUTHORIZES an INQUIRY room that has no order at all', async () => {
      mockPrisma.chatRoom.findUnique.mockResolvedValue({
        id: 'room-9',
        type: 'INQUIRY',
        status: 'ACTIVE',
        subject: 'Nego harga',
        initiatorId: 'buyer',
        counterpartId: 'seller',
        order: null,
      });
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
      const context = await service.validateRoomAccess('seller', 'room-9');
      expect(context).toMatchObject({ id: 'room-9', type: 'INQUIRY', order: null });
    });

    it('FALLS BACK to order parties for legacy rooms without participants', async () => {
      mockPrisma.chatRoom.findUnique.mockResolvedValue({
        id: 'room-1',
        type: 'ORDER',
        status: 'ACTIVE',
        subject: null,
        initiatorId: null,
        counterpartId: null,
        order: ROOM.order,
      });
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
      await expect(service.validateRoomAccess('seller', 'room-1')).resolves.toBeDefined();
    });
  });

  describe('sendMessage — chat room closed grace period', () => {
    it('REJECTS send when order completed >24h ago', async () => {
      const completedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
      mockPrisma.chatRoom.findUnique.mockResolvedValue({
        id: 'room-1',
        type: 'ORDER',
        status: 'ACTIVE',
        initiatorId: 'buyer',
        counterpartId: 'seller',
        order: { id: 'o1', orderId: 'O1', buyerId: 'buyer', sellerId: 'seller', status: 'COMPLETED', completedAt, cancelledAt: null },
      });
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
      await expect(
        service.sendMessage('buyer', 'room-1', { content: 'hello', messageType: 'TEXT' } as never),
      ).rejects.toMatchObject({ response: { code: expect.stringMatching(/CLOSED/) } });
    });
  });

  // ============================================================
  // Trust & Safety — deteksi circumvention (audit 2026-09-13)
  // ============================================================

  describe('sendMessage — circumvention detection', () => {
    beforeEach(() => {
      mockPrisma.chatRoom.findUnique.mockResolvedValue(ROOM);
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
    });

    it('BLOCKS a phone number and records a moderation event', async () => {
      await expect(
        service.sendMessage('buyer', 'room-1', { content: 'hubungi saya 081234567890 ya', messageType: 'TEXT' } as never),
      ).rejects.toMatchObject({ response: { code: 'CHAT_MESSAGE_BLOCKED' } });

      expect(mockPrisma.chatMessage.create).not.toHaveBeenCalled();
      expect(mockPrisma.chatModerationEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'BLOCKED', kind: 'CIRCUMVENTION', userId: 'buyer', roomId: 'room-1' }),
        }),
      );
    });

    it('BLOCKS a wa.me link', async () => {
      await expect(
        service.sendMessage('buyer', 'room-1', { content: 'lanjut di wa.me/6281234567890', messageType: 'TEXT' } as never),
      ).rejects.toMatchObject({ response: { code: 'CHAT_MESSAGE_BLOCKED' } });
    });

    it('ALLOWS an ordinary message and persists it', async () => {
      mockPrisma.chatMessage.create.mockResolvedValue(messageFixture());
      await service.sendMessage('buyer', 'room-1', { content: 'barang sudah ready kak', messageType: 'TEXT' } as never);
      expect(mockPrisma.chatMessage.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ content: 'barang sudah ready kak', moderationAction: null }),
      }));
      expect(mockPrisma.chatModerationEvent.create).not.toHaveBeenCalled();
    });

    it('REDACTS severe profanity instead of blocking the message', async () => {
      mockPrisma.chatMessage.create.mockResolvedValue(messageFixture({ content: 'dasar a****g' }));
      await service.sendMessage('buyer', 'room-1', { content: 'dasar anjing', messageType: 'TEXT' } as never);
      const createArgs = mockPrisma.chatMessage.create.mock.calls[0][0];
      expect(createArgs.data.content).not.toContain('anjing');
      expect(createArgs.data.moderationAction).toBe('REDACTED');
      expect(mockPrisma.chatModerationEvent.create).toHaveBeenCalled();
    });

    it('REDACTS a phone number hidden in an attachment file name', async () => {
      const attachment = {
        fileName: 'bukti-transfer-081234567890.pdf',
        fileSize: 1024,
        mimeType: 'application/pdf',
        fileUrl: 'https://r2.example.com/uploads/chat-attachments/buyer/bukti-transfer-081234567890.pdf',
      };
      mockPrisma.chatMessage.create.mockResolvedValue(messageFixture({ messageType: 'FILE' }));
      await service.sendMessage('buyer', 'room-1', { messageType: 'FILE', attachments: [attachment] } as never);
      const createArgs = mockPrisma.chatMessage.create.mock.calls[0][0];
      expect(createArgs.data.attachments.create[0].fileName).not.toContain('081234567890');
    });
  });

  // ============================================================
  // Trust & Safety — kunci bukti saat dispute (audit 2026-09-13)
  // ============================================================

  describe('deleteMessage', () => {
    function arrangeDisputed(status = 'DISPUTED') {
      mockPrisma.chatRoom.findUnique.mockResolvedValue({ ...ROOM, order: { ...ROOM.order, status } });
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
      mockPrisma.chatMessage.findFirst.mockResolvedValue({ id: 'msg-1', roomId: 'room-1', senderId: 'buyer', content: 'bukti penting' });
    }

    it('THROWS NotFoundException when message does not exist', async () => {
      mockPrisma.chatRoom.findUnique.mockResolvedValue(ROOM);
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
      mockPrisma.chatMessage.findFirst.mockResolvedValue(null);
      await expect(service.deleteMessage('buyer', 'room-1', 'msg-x')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('THROWS ForbiddenException when deleting another user\'s message', async () => {
      mockPrisma.chatRoom.findUnique.mockResolvedValue(ROOM);
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
      mockPrisma.chatMessage.findFirst.mockResolvedValue({ id: 'msg-1', roomId: 'room-1', senderId: 'seller' });
      await expect(service.deleteMessage('buyer', 'room-1', 'msg-1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('REFUSES deletion while the order is DISPUTED (evidence lock)', async () => {
      arrangeDisputed();
      await expect(service.deleteMessage('buyer', 'room-1', 'msg-1')).rejects.toMatchObject({
        response: { code: 'CHAT_MESSAGE_LOCKED_DISPUTE' },
      });
      expect(mockPrisma.chatMessage.update).not.toHaveBeenCalled();
    });

    it('REFUSES deletion when an unresolved dispute row exists', async () => {
      arrangeDisputed('PROCESSING');
      mockPrisma.dispute.findFirst.mockResolvedValue({ id: 'dispute-1' });
      await expect(service.deleteMessage('buyer', 'room-1', 'msg-1')).rejects.toMatchObject({
        response: { code: 'CHAT_MESSAGE_LOCKED_DISPUTE' },
      });
    });

    it('RETAINS the original content in deletedContent when deleting', async () => {
      arrangeDisputed('PROCESSING');
      mockPrisma.chatMessage.update.mockResolvedValue({});
      await expect(service.deleteMessage('buyer', 'room-1', 'msg-1')).resolves.toEqual({ message: 'Message deleted successfully' });
      expect(mockPrisma.chatMessage.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'msg-1' },
        data: expect.objectContaining({
          isDeleted: true,
          content: null,
          deletedContent: 'bukti penting',
          deletedById: 'buyer',
        }),
      }));
    });

    it('emits to the public order id AND the chat room', async () => {
      arrangeDisputed('PROCESSING');
      mockPrisma.chatMessage.update.mockResolvedValue({});
      await service.deleteMessage('buyer', 'room-1', 'msg-1');
      expect(mockRealtime.emitToOrder).toHaveBeenCalledWith('ORD-2026-0007', 'chat.message_deleted', { messageId: 'msg-1', roomId: 'room-1' });
      expect(mockRealtime.emitToChatRoom).toHaveBeenCalledWith('room-1', 'chat.message_deleted', { messageId: 'msg-1', roomId: 'room-1' });
    });
  });

  // ============================================================
  // Edit message (isEdited sebelumnya tidak pernah di-set)
  // ============================================================

  describe('editMessage', () => {
    beforeEach(() => {
      mockPrisma.chatRoom.findUnique.mockResolvedValue(ROOM);
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
    });

    it('SETS isEdited, records the previous content, and emits an update', async () => {
      mockPrisma.chatMessage.findFirst
        .mockResolvedValueOnce({ id: 'msg-1', senderId: 'buyer', messageType: 'TEXT', content: 'halo' })
        .mockResolvedValueOnce(messageFixture({ content: 'halo paketnya ready?', isEdited: true }));

      const result = await service.editMessage('buyer', 'room-1', 'msg-1', 'halo paketnya ready?');

      expect(mockPrisma.chatMessageEdit.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ messageId: 'msg-1', previousContent: 'halo', editorId: 'buyer' }),
      }));
      expect(mockPrisma.chatMessage.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ isEdited: true, content: 'halo paketnya ready?' }),
      }));
      expect(mockRealtime.emitToChatRoom).toHaveBeenCalledWith('room-1', 'chat.message_updated', expect.anything());
      expect(result).toMatchObject({ isEdited: true });
    });

    it('REFUSES editing someone else\'s message', async () => {
      mockPrisma.chatMessage.findFirst.mockResolvedValue({ id: 'msg-1', senderId: 'seller', messageType: 'TEXT', content: 'x' });
      await expect(service.editMessage('buyer', 'room-1', 'msg-1', 'y')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('REFUSES editing a non-text message', async () => {
      mockPrisma.chatMessage.findFirst.mockResolvedValue({ id: 'msg-1', senderId: 'buyer', messageType: 'IMAGE', content: null });
      await expect(service.editMessage('buyer', 'room-1', 'msg-1', 'y')).rejects.toMatchObject({
        response: { code: 'CHAT_MESSAGE_NOT_EDITABLE' },
      });
    });

    it('REFUSES editing while the order is DISPUTED', async () => {
      mockPrisma.chatRoom.findUnique.mockResolvedValue({ ...ROOM, order: { ...ROOM.order, status: 'DISPUTED' } });
      mockPrisma.chatMessage.findFirst.mockResolvedValue({ id: 'msg-1', senderId: 'buyer', messageType: 'TEXT', content: 'x' });
      await expect(service.editMessage('buyer', 'room-1', 'msg-1', 'y')).rejects.toMatchObject({
        response: { code: 'CHAT_MESSAGE_LOCKED_DISPUTE' },
      });
      // Kunci ini penting: edit yang lolos = bukti yang bisa diubah diam-diam.
      expect(mockPrisma.chatMessage.update).not.toHaveBeenCalled();
    });

    it('BLOCKS an edit that smuggles in a phone number', async () => {
      mockPrisma.chatMessage.findFirst.mockResolvedValue({ id: 'msg-1', senderId: 'buyer', messageType: 'TEXT', content: 'halo' });
      await expect(service.editMessage('buyer', 'room-1', 'msg-1', 'nomor saya 081234567890')).rejects.toMatchObject({
        response: { code: 'CHAT_MESSAGE_BLOCKED' },
      });
    });
  });

  // ============================================================
  // Reactions
  // ============================================================

  describe('reactions', () => {
    beforeEach(() => {
      mockPrisma.chatRoom.findUnique.mockResolvedValue(ROOM);
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
      mockPrisma.chatMessage.findFirst.mockResolvedValue({ id: 'msg-1' });
    });

    it('ADDS a reaction and broadcasts the summary', async () => {
      mockPrisma.chatMessageReaction.upsert.mockResolvedValue({ id: 'r1' });
      mockPrisma.chatMessageReaction.findMany.mockResolvedValue([{ emoji: '👍', userId: 'buyer', user: { userId: 'buyer', fullName: 'Buyer' } }]);

      const result = await service.addReaction('buyer', 'room-1', 'msg-1', '👍');

      expect(mockPrisma.chatMessageReaction.upsert).toHaveBeenCalled();
      expect(result).toEqual({
        roomId: 'room-1',
        messageId: 'msg-1',
        reactions: [{ emoji: '👍', count: 1, reactedByMe: true, users: [{ userId: 'buyer', fullName: 'Buyer' }] }],
      });
      expect(mockRealtime.emitToChatRoom).toHaveBeenCalledWith('room-1', 'chat.reaction_updated', expect.anything());
    });

    it('REMOVES a reaction', async () => {
      mockPrisma.chatMessageReaction.deleteMany.mockResolvedValue({ count: 1 });
      mockPrisma.chatMessageReaction.findMany.mockResolvedValue([]);
      const result = await service.removeReaction('buyer', 'room-1', 'msg-1', '👍');
      expect(mockPrisma.chatMessageReaction.deleteMany).toHaveBeenCalledWith({ where: { messageId: 'msg-1', userId: 'buyer', emoji: '👍' } });
      expect(result).toMatchObject({ reactions: [] });
    });

    it('REJECTS a non-emoji reaction', async () => {
      await expect(service.addReaction('buyer', 'room-1', 'msg-1', 'hallo')).rejects.toMatchObject({
        response: { code: 'CHAT_INVALID_EMOJI' },
      });
    });
  });

  // ============================================================
  // Pin & forward
  // ============================================================

  describe('pinMessage', () => {
    beforeEach(() => {
      mockPrisma.chatRoom.findUnique.mockResolvedValue(ROOM);
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
      mockPrisma.chatMessage.findFirst.mockResolvedValue({ id: 'msg-1' });
      mockPrisma.chatMessage.update.mockResolvedValue({});
    });

    it('PINS a message and emits chat.message_pinned', async () => {
      const result = await service.pinMessage('buyer', 'room-1', 'msg-1', true);
      expect(mockPrisma.chatMessage.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ isPinned: true, pinnedById: 'buyer' }),
      }));
      expect(result).toMatchObject({ isPinned: true });
      expect(mockRealtime.emitToChatRoom).toHaveBeenCalledWith('room-1', 'chat.message_pinned', expect.anything());
    });

    it('ENFORCES the pin limit', async () => {
      mockPrisma.chatMessage.count.mockResolvedValue(20);
      await expect(service.pinMessage('buyer', 'room-1', 'msg-1', true)).rejects.toMatchObject({
        response: { code: 'CHAT_PIN_LIMIT_REACHED' },
      });
    });
  });

  describe('forwardMessage', () => {
    beforeEach(() => {
      mockPrisma.chatMessage.findFirst.mockResolvedValue({
        id: 'msg-1',
        content: 'alamat kirim',
        messageType: 'TEXT',
        senderId: 'buyer',
        durationSeconds: null,
        attachments: [],
      });
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
      mockPrisma.chatMessage.create.mockResolvedValue(messageFixture({ id: 'msg-2', content: 'alamat kirim' }));
    });

    it('FORWARDS to a room with the SAME counterpart', async () => {
      mockPrisma.chatRoom.findUnique
        .mockResolvedValueOnce(ROOM)
        .mockResolvedValueOnce({ ...ROOM, id: 'room-2' });

      const result = await service.forwardMessage('buyer', 'room-1', 'msg-1', ['room-2']) as {
        forwarded: { roomId: string }[];
        skipped: { roomId: string }[];
      };
      expect(result.forwarded).toHaveLength(1);
      expect(result.skipped).toHaveLength(0);
      expect(mockPrisma.chatMessage.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ roomId: 'room-2', forwardedFromId: 'msg-1' }),
      }));
    });

    it('REFUSES forwarding to a room with a DIFFERENT counterpart', async () => {
      mockPrisma.chatRoom.findUnique
        .mockResolvedValueOnce(ROOM)
        .mockResolvedValueOnce({ ...ROOM, id: 'room-3', initiatorId: 'buyer', counterpartId: 'seller-lain' });

      await expect(service.forwardMessage('buyer', 'room-1', 'msg-1', ['room-3'])).rejects.toMatchObject({
        response: { code: 'CHAT_FORWARD_NOT_ALLOWED' },
      });
      expect(mockPrisma.chatMessage.create).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // Archive & mute (per user)
  // ============================================================

  describe('archive & mute', () => {
    beforeEach(() => {
      mockPrisma.chatRoom.findUnique.mockResolvedValue(ROOM);
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
    });

    it('ARCHIVES the room for the current user only', async () => {
      await service.setRoomArchived('buyer', 'room-1', true);
      expect(mockPrisma.chatRoomMember.upsert).toHaveBeenCalledWith(expect.objectContaining({
        where: { roomId_userId: { roomId: 'room-1', userId: 'buyer' } },
      }));
      expect(mockPrisma.chatRoomMember.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ isArchived: true }),
      }));
    });

    it('MIRRORS ChatRoom.isArchived only when every member archived', async () => {
      mockPrisma.chatRoomMember.findMany.mockResolvedValue([{ isArchived: true }, { isArchived: true }]);
      await service.setRoomArchived('buyer', 'room-1', true);
      expect(mockPrisma.chatRoom.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ isArchived: true }),
      }));

      mockPrisma.chatRoomMember.findMany.mockResolvedValue([{ isArchived: true }, { isArchived: false }]);
      await service.setRoomArchived('buyer', 'room-1', true);
      expect(mockPrisma.chatRoom.update).toHaveBeenLastCalledWith(expect.objectContaining({
        data: expect.objectContaining({ isArchived: false }),
      }));
    });

    it('MUTES with an expiry', async () => {
      const result = await service.setRoomMuted('buyer', 'room-1', true, 24) as { mutedUntil: Date | null };
      expect(result.mutedUntil).toBeInstanceOf(Date);
      expect(result.mutedUntil!.getTime()).toBeGreaterThan(Date.now());
    });
  });

  // ============================================================
  // Search & presence
  // ============================================================

  describe('search', () => {
    it('REJECTS a query shorter than the minimum', async () => {
      await expect(service.searchMessages('buyer', 'room-1', 'a')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('SEARCHES a room with a case-insensitive contains filter', async () => {
      mockPrisma.chatRoom.findUnique.mockResolvedValue(ROOM);
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
      mockPrisma.chatMessage.findMany.mockResolvedValue([messageFixture({ content: 'nomor resi JNE123' })]);

      const result = await service.searchMessages('buyer', 'room-1', 'resi') as { messages: unknown[]; query: string };
      expect(mockPrisma.chatMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ content: { contains: 'resi', mode: 'insensitive' } }),
      }));
      expect(result.messages).toHaveLength(1);
    });

    it('SEARCHES across all rooms of the user', async () => {
      mockPrisma.chatRoom.findMany.mockResolvedValue([{ id: 'room-1' }, { id: 'room-2' }]);
      mockPrisma.chatMessage.findMany.mockResolvedValue([
        { ...messageFixture({ content: 'resi JNE' }), room: { id: 'room-1', type: 'ORDER', subject: null, initiatorId: 'buyer', counterpartId: 'seller', order: { orderId: 'ORD-1', title: 'Sepatu', status: 'PROCESSING' } } },
      ]);
      const result = await service.searchAllMessages('buyer', 'resi') as { results: { room: { orderId: string } }[] };
      expect(mockPrisma.chatMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ roomId: { in: ['room-1', 'room-2'] } }),
      }));
      expect(result.results[0].room.orderId).toBe('ORD-1');
    });
  });

  describe('presence', () => {
    it('HIDES online status when the counterpart disabled it', async () => {
      mockPrisma.chatRoom.findUnique.mockResolvedValue(ROOM);
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
      mockPrisma.user.findMany.mockResolvedValue([{ id: 'seller', showOnlineStatus: false }]);
      mockRealtime.isUserOnline.mockResolvedValue(true);

      const presence = await service.getRoomPresence('buyer', 'room-1') as { isOnline: boolean; lastSeenAt: Date | null };
      expect(presence.isOnline).toBe(false);
      expect(presence.lastSeenAt).toBeNull();
    });

    it('REPORTS online when the counterpart allows it', async () => {
      mockPrisma.chatRoom.findUnique.mockResolvedValue(ROOM);
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
      mockPrisma.user.findMany.mockResolvedValue([{ id: 'seller', showOnlineStatus: true }]);
      mockRealtime.isUserOnline.mockResolvedValue(true);

      const presence = await service.getRoomPresence('buyer', 'room-1') as { isOnline: boolean };
      expect(presence.isOnline).toBe(true);
    });
  });

  // ============================================================
  // Pre-transaction inquiry rooms
  // ============================================================

  describe('createInquiry', () => {
    beforeEach(() => {
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
      mockPrisma.chatRoom.findFirst.mockResolvedValue(null);
      mockPrisma.chatRoom.create.mockResolvedValue({ id: 'room-new' });
      mockPrisma.chatRoom.findUnique.mockResolvedValue({
        id: 'room-new',
        type: 'INQUIRY',
        status: 'ACTIVE',
        subject: null,
        initiatorId: 'buyer',
        counterpartId: 'seller',
        order: null,
      });
      mockPrisma.chatMessage.create.mockResolvedValue(messageFixture({ id: 'msg-new', roomId: 'room-new' }));
    });

    it('CREATES a pre-transaction room and posts the first message', async () => {
      const result = await service.createInquiry('buyer', { counterpartId: 'seller', subject: 'Nego harga', message: 'Halo, bisa nego?' }) as {
        room: { type: string; initiatorId: string; counterpartId: string };
      };
      expect(mockPrisma.chatRoom.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ type: 'INQUIRY', initiatorId: 'buyer', counterpartId: 'seller' }),
      }));
      expect(mockPrisma.chatMessage.create).toHaveBeenCalled();
      expect(result.room.type).toBe('INQUIRY');
    });

    it('ORDERS the pair canonically so the unique index can work', async () => {
      // 'zz-seller' > 'buyer' → buyer tetap initiator walau dia yang memulai.
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'zz-seller', isActive: true, isBanned: false });
      mockPrisma.chatRoom.findUnique.mockResolvedValue({
        id: 'room-new',
        type: 'INQUIRY',
        status: 'ACTIVE',
        subject: null,
        initiatorId: 'buyer',
        counterpartId: 'zz-seller',
        order: null,
      });
      await service.createInquiry('zz-seller', { counterpartId: 'buyer', message: 'Halo' });
      expect(mockPrisma.chatRoom.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ initiatorId: 'buyer', counterpartId: 'zz-seller' }),
      }));
    });

    it('REUSES an existing inquiry room for the same pair', async () => {
      mockPrisma.chatRoom.findFirst.mockResolvedValue({ id: 'room-existing' });
      mockPrisma.chatRoom.findUnique.mockResolvedValue({
        id: 'room-existing',
        type: 'INQUIRY',
        status: 'ACTIVE',
        subject: null,
        initiatorId: 'buyer',
        counterpartId: 'seller',
        order: null,
      });
      await service.createInquiry('buyer', { counterpartId: 'seller', message: 'Halo lagi' });
      expect(mockPrisma.chatRoom.create).not.toHaveBeenCalled();
      expect(mockPrisma.chatMessage.create).toHaveBeenCalled();
    });

    it('REJECTS opening a conversation with yourself', async () => {
      await expect(service.createInquiry('buyer', { counterpartId: 'buyer', message: 'Halo' })).rejects.toMatchObject({
        response: { code: 'CHAT_INQUIRY_SELF' },
      });
    });

    it('ENFORCES the active-inquiry limit', async () => {
      mockPrisma.chatRoom.count.mockResolvedValue(30);
      await expect(service.createInquiry('buyer', { counterpartId: 'seller', message: 'Halo' })).rejects.toMatchObject({
        response: { code: 'CHAT_INQUIRY_LIMIT_REACHED' },
      });
    });

    it('REFUSES when either side has blocked the other', async () => {
      mockPrisma.blockList.findFirst.mockResolvedValue({ id: 'block-1' });
      await expect(service.createInquiry('buyer', { counterpartId: 'seller', message: 'Halo' })).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ============================================================
  // Admin / dispute resolver view
  // ============================================================

  describe('getRoomMessagesForAdmin', () => {
    it('INCLUDES deleted content for dispute resolvers', async () => {
      mockPrisma.chatMessage.findMany.mockResolvedValue([
        messageFixture({ id: 'msg-1', isDeleted: true, content: null, deletedContent: 'isi asli yang dihapus' }),
      ]);
      const result = await service.getRoomMessagesForAdmin('room-1', { includeDeleted: true }) as {
        messages: { deletedContent?: string }[];
      };
      expect(result.messages[0].deletedContent).toBe('isi asli yang dihapus');
    });

    it('HIDES deleted content from the participant-facing serializer', async () => {
      mockPrisma.chatRoom.findUnique.mockResolvedValue(ROOM);
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
      mockPrisma.chatMessage.findMany.mockResolvedValue([
        messageFixture({ id: 'msg-1', isDeleted: true, content: null, deletedContent: 'isi asli' }),
      ]);
      const result = await service.getMessages('buyer', 'room-1') as { messages: Record<string, unknown>[] };
      expect(result.messages[0].deletedContent).toBeUndefined();
      expect(result.messages[0].content).toBeNull();
    });
  });

  describe('sendMessage — attachment MIME validation', () => {
    const room = {
      id: 'room-1',
      type: 'ORDER',
      status: 'ACTIVE',
      initiatorId: 'buyer',
      counterpartId: 'seller',
      order: { id: 'o1', orderId: 'O1', buyerId: 'buyer', sellerId: 'seller', status: 'PROCESSING', completedAt: null, cancelledAt: null },
    };

    it('REJECTS attachments with disallowed MIME type (e.g. application/x-msdownload)', async () => {
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

  describe('voice notes', () => {
    beforeEach(() => {
      mockPrisma.chatRoom.findUnique.mockResolvedValue(ROOM);
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
    });

    it('ACCEPTS a VOICE message with an audio attachment and duration', async () => {
      mockPrisma.chatMessage.create.mockResolvedValue(messageFixture({ messageType: 'VOICE', content: null, durationSeconds: 12 }));
      const result = await service.sendMessage('buyer', 'room-1', {
        messageType: 'VOICE',
        durationSeconds: 12,
        attachments: [
          {
            fileName: 'voice.m4a',
            fileSize: 2048,
            mimeType: 'audio/m4a',
            fileUrl: 'https://r2.example.com/uploads/chat-attachments/buyer/voice.m4a',
          },
        ],
      } as never);
      expect(mockPrisma.chatMessage.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ messageType: 'VOICE', durationSeconds: 12 }),
      }));
      expect(result).toMatchObject({ durationSeconds: 12 });
    });

    it('REJECTS a VOICE message with a non-audio attachment', async () => {
      await expect(service.sendMessage('buyer', 'room-1', {
        messageType: 'VOICE',
        durationSeconds: 12,
        attachments: [
          {
            fileName: 'voice.jpg',
            fileSize: 2048,
            mimeType: 'image/jpeg',
            fileUrl: 'https://r2.example.com/uploads/chat-attachments/buyer/voice.jpg',
          },
        ],
      } as never)).rejects.toMatchObject({
        response: { message: expect.stringMatching(/audio MIME/i) },
      });
    });

    it('REJECTS a VOICE message without a duration', async () => {
      await expect(service.sendMessage('buyer', 'room-1', {
        messageType: 'VOICE',
        attachments: [
          {
            fileName: 'voice.m4a',
            fileSize: 2048,
            mimeType: 'audio/m4a',
            fileUrl: 'https://r2.example.com/uploads/chat-attachments/buyer/voice.m4a',
          },
        ],
      } as never)).rejects.toMatchObject({
        response: { code: 'VALIDATION_ERROR' },
      });
    });
  });

  void BadRequestException;
});
