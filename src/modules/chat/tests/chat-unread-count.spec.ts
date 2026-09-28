/**
 * NS-006 (perf-fix, 2026-09-29): `getTotalUnreadCount` — badge tab Pesan
 * dihitung dari SATU aggregate ringan pada counter denormalisasi
 * `chat_room_members.unreadCount`, dengan semantik SAMA seperti room list
 * lama (default non-arsip): membership yang diarsipkan tidak dihitung.
 */
import { ChatService } from '../chat.service';

describe('ChatService.getTotalUnreadCount — NS-006', () => {
  const makeService = (sum: number | null) => {
    const prisma = {
      chatRoomMember: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { unreadCount: sum } }),
      },
    };
    const service = new ChatService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, prisma };
  };

  it('memakai filter { userId, isArchived: false } — arsip tidak dihitung', async () => {
    const { service, prisma } = makeService(7);
    const res = await service.getTotalUnreadCount('user-1');
    expect(prisma.chatRoomMember.aggregate).toHaveBeenCalledTimes(1);
    expect(prisma.chatRoomMember.aggregate).toHaveBeenCalledWith({
      where: { userId: 'user-1', isArchived: false },
      _sum: { unreadCount: true },
    });
    expect(res).toEqual({ unreadCount: 7 });
  });

  it('null → 0 (tidak ada membership)', async () => {
    const { service } = makeService(null);
    await expect(service.getTotalUnreadCount('user-1')).resolves.toEqual({ unreadCount: 0 });
  });

  it('tidak pernah negatif', async () => {
    const { service } = makeService(-3);
    await expect(service.getTotalUnreadCount('user-1')).resolves.toEqual({ unreadCount: 0 });
  });
});
