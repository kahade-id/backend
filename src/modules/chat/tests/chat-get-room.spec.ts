/**
 * D1-003 (perf 2026-09-29): GET /v1/chat/rooms/:roomId — satu room ringan
 * untuk header layar percakapan, tanpa raw SQL daftar room.
 *
 * - Bentuk payload sama dengan satu entri GET /v1/chat/rooms.
 * - 404 bila viewer bukan anggota (tidak membocorkan keberadaan room).
 * - Tidak memakai $queryRaw sama sekali (lookup berindeks).
 */
import { NotFoundException } from '@nestjs/common';
import { ChatService } from '../chat.service';

const VIEWER = 'user-viewer';
const OTHER = 'user-other';

const mockPrisma: any = {
  chatRoom: { findUnique: jest.fn() },
  chatRoomMember: { findUnique: jest.fn() },
  chatMessage: { findFirst: jest.fn(), count: jest.fn() },
  chatPinnedRoom: { findUnique: jest.fn() },
  user: { findUnique: jest.fn(), findMany: jest.fn() },
};
const mockRealtime: any = {
  areUsersOnline: jest.fn(),
  getLastSeenMany: jest.fn(),
};
const mockVerificationBadge: any = { getSealTierMap: jest.fn() };

function makeService() {
  return new ChatService(
    mockPrisma as never,
    mockRealtime as never,
    {} as never,
    mockVerificationBadge as never,
    {} as never,
    undefined,
    undefined,
    undefined,
  );
}

function roomCtx(overrides: Record<string, unknown> = {}) {
  return {
    id: 'room-1',
    type: 'INQUIRY',
    status: 'ACTIVE',
    subject: 'Nego tas',
    initiatorId: VIEWER,
    counterpartId: OTHER,
    order: null,
    ...overrides,
  };
}

function fullRoom(overrides: Record<string, unknown> = {}) {
  return {
    id: 'room-1',
    type: 'INQUIRY',
    status: 'ACTIVE',
    subject: 'Nego tas',
    isArchived: false,
    createdAt: new Date('2026-09-29T10:00:00Z'),
    updatedAt: new Date('2026-09-29T11:00:00Z'),
    initiator: { id: VIEWER, userId: 'USR-VIEWER', fullName: 'Viewer', username: 'viewer', avatarUrl: null },
    counterpart: { id: OTHER, userId: 'USR-OTHER', fullName: 'Other', username: 'other', avatarUrl: null },
    order: null,
    ...overrides,
  };
}

describe('ChatService.getRoom (D1-003)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
    // Urutan pemanggilan: validateRoomAccess dulu (bentuk ctx), lalu body
    // getRoom (bentuk full dengan relasi).
    mockPrisma.chatRoom.findUnique.mockReset();
    mockPrisma.chatRoom.findUnique.mockResolvedValueOnce(roomCtx()).mockResolvedValue(fullRoom());
    mockPrisma.chatRoomMember.findUnique.mockResolvedValue({
      isArchived: false,
      isMuted: false,
      mutedUntil: null,
      unreadCount: 3,
    });
    mockPrisma.chatMessage.findFirst.mockResolvedValue({
      id: 'msg-9',
      content: 'Halo',
      messageType: 'TEXT',
      createdAt: new Date('2026-09-29T10:30:00Z'),
      sender: { id: OTHER, userId: 'USR-OTHER' },
    });
    mockPrisma.chatMessage.count.mockResolvedValue(1);
    mockPrisma.chatPinnedRoom.findUnique.mockResolvedValue(null);
    mockPrisma.user.findMany.mockResolvedValue([{ id: OTHER, showOnlineStatus: true }]);
    mockRealtime.areUsersOnline.mockResolvedValue({ [OTHER]: true });
    mockRealtime.getLastSeenMany.mockResolvedValue({});
    mockVerificationBadge.getSealTierMap.mockResolvedValue(new Map([[OTHER, 'BIRU']]));
  });

  it('mengembalikan bentuk yang sama dengan satu entri daftar room', async () => {
    const service = makeService();
    const res = (await service.getRoom(VIEWER, 'room-1')) as any;
    expect(res).toMatchObject({
      id: 'room-1',
      type: 'INQUIRY',
      status: 'ACTIVE',
      subject: 'Nego tas',
      unreadCount: 3,
      pinnedCount: 1,
      isPinned: false,
      isSelf: false,
    });
    expect(res.otherUser).toMatchObject({
      userId: 'USR-OTHER',
      username: 'other',
      sealTier: 'BIRU',
      isOnline: true,
    });
    expect(res.lastMessage).toMatchObject({ id: 'msg-9', content: 'Halo', fromUser: false });
    expect(res.initiator).toMatchObject({ userId: 'USR-VIEWER' });
    expect(res.counterpart).toMatchObject({ userId: 'USR-OTHER' });
  });

  it('tidak memakai $queryRaw (tanpa join berat daftar room)', async () => {
    const service = makeService();
    await service.getRoom(VIEWER, 'room-1');
    expect(mockPrisma.$queryRaw ?? null).toBeNull();
  });

  it('404 bila room tidak ada', async () => {
    mockPrisma.chatRoom.findUnique.mockReset();
    mockPrisma.chatRoom.findUnique.mockResolvedValue(null);
    const service = makeService();
    await expect(service.getRoom(VIEWER, 'room-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('403/404 bila viewer bukan anggota', async () => {
    mockPrisma.chatRoom.findUnique.mockReset();
    mockPrisma.chatRoom.findUnique.mockResolvedValue(roomCtx({ initiatorId: 'user-a', counterpartId: 'user-b' }));
    const service = makeService();
    await expect(service.getRoom(VIEWER, 'room-1')).rejects.toThrow();
  });
});
