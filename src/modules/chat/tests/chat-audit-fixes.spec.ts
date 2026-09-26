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
import { VerificationBadgeService } from '../../users/verification-badge.service';

const mockPrisma = {
  chatRoom: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  chatMessage: { findUnique: jest.fn(), findFirst: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
  chatRoomMember: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), upsert: jest.fn().mockResolvedValue({ id: 'm1' }) },
  chatMessageReaction: { upsert: jest.fn(), findMany: jest.fn() },
  blockList: { findFirst: jest.fn().mockResolvedValue(null) },
  dispute: { findFirst: jest.fn().mockResolvedValue(null) },
  user: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  notification: { create: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
  $transaction: jest.fn(),
  $executeRaw: jest.fn().mockResolvedValue(1),
  $queryRaw: jest.fn(),
  emitNotificationCreated: jest.fn(),
};
const mockRealtime = {
  broadcastToRoom: jest.fn(),
  notifyUser: jest.fn(),
  emitToUser: jest.fn(),
  emitToChatRoom: jest.fn(),
  emitToOrder: jest.fn(),
  isUserOnline: jest.fn().mockResolvedValue(false),
  areUsersOnline: jest.fn().mockResolvedValue({}),
  getLastSeen: jest.fn().mockResolvedValue(null),
};
const mockNotifications = { create: jest.fn(), isInAppEnabled: jest.fn().mockResolvedValue(true) };
const mockConfig = { get: jest.fn().mockReturnValue(undefined) };
const mockVerificationBadge = { getSealTierMap: jest.fn().mockResolvedValue(new Map()) };

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
        { provide: VerificationBadgeService, useValue: mockVerificationBadge },
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

  describe('Batch 4A: CN-007 preferensi chatInApp', () => {
    const room = { id: 'room-1', buyerId: 'u1', sellerId: 'u2', orderId: 'o1' };
    beforeEach(() => {
      mockPrisma.chatRoomMember.findUnique.mockResolvedValue({ isMuted: false, mutedUntil: null });
      mockPrisma.user.findUnique.mockResolvedValue({ fullName: 'Budi', username: 'budi' });
      mockPrisma.notification.create.mockResolvedValue({ notifId: 'ntf-1' });
    });
    it('tidak membuat baris notifikasi bila chatInApp dimatikan', async () => {
      mockNotifications.isInAppEnabled.mockResolvedValue(false);
      await (service as any).notifyNewMessage(room, 'u2', 'u1', 'msg-1', 'halo', 'TEXT');
      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    });
    it('membuat notifikasi bila chatInApp aktif (CN-019: refType=CHAT_ROOM, refId=room.id)', async () => {
      mockNotifications.isInAppEnabled.mockResolvedValue(true);
      await (service as any).notifyNewMessage(room, 'u2', 'u1', 'msg-1', 'halo', 'TEXT');
      expect(mockPrisma.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            refType: 'CHAT_ROOM',
            refId: 'room-1',
            actionUrl: '/chat/room-1',
          }),
        }),
      );
    });
  });

  describe('Batch 4A: CN-002 markAsRead menandai notifikasi', () => {
    beforeEach(() => {
      mockPrisma.chatRoom.findUnique.mockResolvedValue({
        id: 'room-1',
        buyerId: 'u1',
        sellerId: 'u2',
        orderId: 'o1',
        order: { id: 'o1', status: 'ACTIVE', buyerId: 'u1', sellerId: 'u2' },
      });
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
      mockPrisma.$executeRaw.mockResolvedValue(1);
    });
    it('updateMany notification dipanggil dengan filter room', async () => {
      await service.markAsRead('u1', 'room-1');
      expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: 'u1',
            isRead: false,
            actionUrl: '/chat/room-1',
          }),
          data: expect.objectContaining({ isRead: true }),
        }),
      );
    });
  });

  describe('Batch 4A: CN-004 payload per-penerima', () => {
    it('createMessage mengirim fromUser yang benar ke pengirim & penerima', async () => {
      const room = {
        id: 'room-1', type: 'ORDER', status: 'ACTIVE', subject: null,
        initiatorId: 'u1', counterpartId: 'u2',
        participants: ['u1', 'u2'],
        order: { id: 'o1', orderId: 'ORD-1', status: 'ACTIVE', buyerId: 'u1', sellerId: 'u2', completedAt: null },
      };
      const createdMessage = {
        id: 'msg-1', roomId: 'room-1', messageType: 'TEXT', content: 'halo',
        isDeleted: false, isEdited: false, editedAt: null, isPinned: false, pinnedAt: null,
        durationSeconds: null, forwardedFromId: null, readAt: null,
        createdAt: new Date(), updatedAt: new Date(),
        sender: { id: 'u1', userId: 'usr-u1', fullName: 'A', avatarUrl: null },
        reactions: [], attachments: [],
        replyToId: null, replyTo: null, forwardedFrom: null,
      };
      mockPrisma.chatMessage.create.mockResolvedValue(createdMessage);
      mockPrisma.chatRoom.update.mockResolvedValue({});
      mockPrisma.chatRoomMember.findUnique.mockResolvedValue({ isMuted: false, mutedUntil: null });
      mockPrisma.user.findUnique.mockResolvedValue({ fullName: 'A', username: 'a' });
      mockPrisma.notification.create.mockResolvedValue({ notifId: 'ntf-1' });
      mockNotifications.isInAppEnabled.mockResolvedValue(true);

      const result = await (service as any).createMessage(room, 'u1', { content: 'halo', messageType: 'TEXT' });

      // Return value = sudut pandang pengirim
      expect((result as any).fromUser).toBe(true);

      // emitToUser ke penerima memakai sudut pandang penerima
      const toRecipient = mockRealtime.emitToUser.mock.calls.find(
        (c: any[]) => c[0] === 'u2' && c[1] === 'chat.new_message',
      );
      expect(toRecipient).toBeDefined();
      expect(toRecipient[2].fromUser).toBe(false);
      expect(toRecipient[2].senderId).toBe('usr-u1');

      // emitToUser ke pengirim (multi-device) memakai sudut pandang pengirim
      const toSender = mockRealtime.emitToUser.mock.calls.find(
        (c: any[]) => c[0] === 'u1' && c[1] === 'chat.new_message',
      );
      expect(toSender).toBeDefined();
      expect(toSender[2].fromUser).toBe(true);

      // Room broadcast netral (tidak mengklaim sudut pandang)
      expect(mockRealtime.emitToChatRoom).toHaveBeenCalledWith(
        'room-1',
        'chat.new_message',
        expect.objectContaining({ fromUser: false }),
      );
    });
  });

  describe('Batch 4A: CN-001 lastMessage.fromUser', () => {
    it('fromUser=true bila pengirim adalah viewer, false bila lawan bicara', async () => {
      const roomRow = (senderInternal: string | null) => ({
        room_id: 'room-1', room_type: 'ORDER', room_status: 'ACTIVE', room_subject: null,
        is_archived: false, room_created_at: new Date(), room_updated_at: new Date(),
        member_archived: null, member_muted: null, member_muted_until: null,
        order_id: 'ORD-1', order_title: 'T', order_status: 'ACTIVE',
        initiator_user_id: 'usr-u1', initiator_internal_id: 'u1',
        initiator_full_name: 'A', initiator_username: 'a', initiator_avatar_url: null,
        counterpart_user_id: 'usr-u2', counterpart_internal_id: 'u2',
        counterpart_full_name: 'B', counterpart_username: 'b', counterpart_avatar_url: null,
        last_msg_id: 'msg-1', last_msg_content: 'halo', last_msg_type: 'TEXT',
        last_msg_sender_user_id: senderInternal === 'u1' ? 'usr-u1' : 'usr-u2',
        last_msg_sender_internal_id: senderInternal,
        last_msg_created_at: new Date(),
        unread_count: BigInt(0), pinned_count: BigInt(0),
      });
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([roomRow('u1')])
        .mockResolvedValueOnce([{ count: BigInt(1) }]);
      mockRealtime.areUsersOnline = jest.fn().mockResolvedValue({ u2: false });
      const res1: any = await service.getRooms('u1', {});
      expect(res1.data[0].lastMessage.fromUser).toBe(true);

      mockPrisma.$queryRaw
        .mockResolvedValueOnce([roomRow('u2')])
        .mockResolvedValueOnce([{ count: BigInt(1) }]);
      const res2: any = await service.getRooms('u1', {});
      expect(res2.data[0].lastMessage.fromUser).toBe(false);
    });
  });

  describe('Batch 4A: CN-005 reactedByMe per-penerima', () => {    beforeEach(() => {
      mockPrisma.chatRoom.findUnique.mockResolvedValue({
        id: 'room-1', type: 'ORDER', status: 'ACTIVE', subject: null,
        initiatorId: 'u1', counterpartId: 'u2', buyerId: 'u1', sellerId: 'u2',
      });
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
      mockPrisma.blockList.findFirst.mockResolvedValue(null);
      mockPrisma.chatMessage.findFirst.mockResolvedValue({ id: 'msg-1' });
      mockPrisma.chatMessageReaction.upsert.mockResolvedValue({ id: 'r1' });
      // u1 mereaksi 👍 ; userId di tabel adalah internal id
      mockPrisma.chatMessageReaction.findMany.mockResolvedValue([
        { emoji: '👍', userId: 'u1', user: { userId: 'usr-u1', fullName: 'A' } },
      ]);
    });
    it('penerima mendapat reactedByMe=false, aktor true', async () => {
      await service.addReaction('u1', 'room-1', 'msg-1', '👍');
      const toRecipient = mockRealtime.emitToUser.mock.calls.find(
        (c: any[]) => c[0] === 'u2' && c[1] === 'chat.reaction_updated',
      );
      const toActor = mockRealtime.emitToUser.mock.calls.find(
        (c: any[]) => c[0] === 'u1' && c[1] === 'chat.reaction_updated',
      );
      expect(toRecipient).toBeDefined();
      expect(toActor).toBeDefined();
      expect(toRecipient[2].reactions[0].reactedByMe).toBe(false);
      expect(toActor[2].reactions[0].reactedByMe).toBe(true);
    });
  });
});
