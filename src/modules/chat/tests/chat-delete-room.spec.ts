import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatService } from '../chat.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { VerificationBadgeService } from '../../users/verification-badge.service';
import * as ErrorCodes from '../../../common/constants/error-codes';

/**
 * Item 7 (batch 2026-09-28) — DELETE /v1/chat/rooms/:id.
 * - DM/INQUIRY tanpa transaksi → hard delete permanen.
 * - Room ORDER + order COMPLETED → soft delete.
 * - Room ORDER + order belum COMPLETED → 409 CHAT_ROOM_DELETE_ORDER_NOT_COMPLETED.
 * - Bukan anggota → 403 (dari validateRoomAccess).
 */
describe('ChatService.deleteRoom', () => {
  const mockPrisma = {
    chatRoom: { delete: jest.fn(), update: jest.fn() },
  };
  const mockRealtime = {};
  const mockNotifications = {};
  const mockVerificationBadge = {};
  const mockConfig = { get: jest.fn() };

  let service: ChatService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ChatService(
      mockPrisma as unknown as PrismaService,
      mockRealtime as unknown as RealtimeService,
      mockConfig as unknown as ConfigService,
      mockVerificationBadge as unknown as VerificationBadgeService,
      mockNotifications as unknown as NotificationsService,
    );
  });

  function roomContext(overrides: Record<string, unknown> = {}) {
    return {
      id: 'room-1',
      type: 'INQUIRY',
      status: 'ACTIVE',
      subject: null,
      initiatorId: 'user-1',
      counterpartId: 'user-2',
      participants: ['user-1', 'user-2'],
      order: null,
      ...overrides,
    };
  }

  it('menghapus permanen DM tanpa transaksi (hard delete)', async () => {
    jest.spyOn(service, 'validateRoomAccess').mockResolvedValue(roomContext() as never);
    mockPrisma.chatRoom.delete.mockResolvedValue({ id: 'room-1' });

    const result = await service.deleteRoom('user-1', 'room-1');

    expect(mockPrisma.chatRoom.delete).toHaveBeenCalledWith({ where: { id: 'room-1' } });
    expect(mockPrisma.chatRoom.update).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: true, roomId: 'room-1', permanent: true });
  });

  it('soft-delete room ORDER bila order sudah COMPLETED', async () => {
    jest.spyOn(service, 'validateRoomAccess').mockResolvedValue(
      roomContext({
        type: 'ORDER',
        order: { id: 'o1', orderId: 'ORD-1', status: 'COMPLETED', completedAt: new Date(), cancelledAt: null, buyerId: 'user-1', sellerId: 'user-2' },
      }) as never,
    );
    mockPrisma.chatRoom.update.mockResolvedValue({ id: 'room-1' });

    const result = await service.deleteRoom('user-1', 'room-1');

    expect(mockPrisma.chatRoom.delete).not.toHaveBeenCalled();
    expect(mockPrisma.chatRoom.update).toHaveBeenCalledWith({
      where: { id: 'room-1' },
      data: { deletedAt: expect.any(Date), status: 'CLOSED' },
    });
    expect(result).toEqual({ deleted: true, roomId: 'room-1', permanent: false });
  });

  it.each(['WAITING_CONFIRMATION', 'WAITING_PAYMENT', 'PROCESSING', 'IN_DELIVERY', 'DISPUTED', 'CANCELLED'])(
    'menolak 409 bila order berstatus %s (fail closed)',
    async (status) => {
      jest.spyOn(service, 'validateRoomAccess').mockResolvedValue(
        roomContext({
          type: 'ORDER',
          order: { id: 'o1', orderId: 'ORD-1', status, completedAt: null, cancelledAt: null, buyerId: 'user-1', sellerId: 'user-2' },
        }) as never,
      );

      const err = await service.deleteRoom('user-1', 'room-1').catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({ code: ErrorCodes.CHAT_ROOM_DELETE_ORDER_NOT_COMPLETED });
      expect(mockPrisma.chatRoom.delete).not.toHaveBeenCalled();
      expect(mockPrisma.chatRoom.update).not.toHaveBeenCalled();
    },
  );

  it('meneruskan 403 bila bukan anggota room', async () => {
    jest
      .spyOn(service, 'validateRoomAccess')
      .mockRejectedValue(new ForbiddenException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'x' }));

    await expect(service.deleteRoom('intruder', 'room-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockPrisma.chatRoom.delete).not.toHaveBeenCalled();
    expect(mockPrisma.chatRoom.update).not.toHaveBeenCalled();
  });
});
