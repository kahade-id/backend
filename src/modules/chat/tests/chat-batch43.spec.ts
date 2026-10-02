import { BadRequestException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { ChatService, filterReadAtForViewer, serializeMessage } from '../chat.service';
import { ChatEphemeralPurgeService } from '../chat-ephemeral-purge.service';
import { ChatOrderHooks } from '../chat-order-hooks';
// NOTE: enum Prisma baru (DmPolicy) tidak bisa di-import sebagai nilai di
// lingkungan jest pada repo ini (quirk resolusi @prisma/client) — pakai
// literal string; Prisma menerima string untuk field enum.
const DmPolicy = { EVERYONE: 'EVERYONE', FOLLOWING: 'FOLLOWING', NONE: 'NONE' } as const;

/**
 * Batch 43 BE-CHAT — spesifikasi perilaku tiap fitur.
 *
 * Catatan: logika uang tidak diuji di sini karena createOrderFromChat
 * mendelegasikan sepenuhnya ke OrdersService.createOrder (escrow existing);
 * spec ini memverifikasi delegasi tersebut + aturan chat di sekitarnya.
 */
describe('ChatService batch-43', () => {
  const mockPrisma: any = {};
  const mockRealtime: any = { emitToUser: jest.fn(), emitToChatRoom: jest.fn(), emitToOrder: jest.fn() };
  const mockConfig: any = { get: jest.fn() };
  const mockNotifications: any = {};
  const mockVerificationBadge: any = {};
  const mockOrdersService: any = { createOrder: jest.fn() };
  const mockTranslation: any = { translate: jest.fn() };

  let service: ChatService;

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

  function makeService(opts: { orders?: boolean; translation?: boolean } = {}) {
    service = new ChatService(
      mockPrisma as never,
      mockRealtime as never,
      mockConfig as never,
      mockVerificationBadge as never,
      mockNotifications as never,
      undefined,
      opts.orders ? (mockOrdersService as never) : undefined,
      opts.translation ? (mockTranslation as never) : undefined,
    );
    jest.spyOn(service, 'validateRoomAccess').mockImplementation(async () => roomContext() as never);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    ChatOrderHooks.reset();
    for (const key of Object.keys(mockPrisma)) delete mockPrisma[key];
    mockPrisma.$executeRaw = jest.fn();
    mockPrisma.privacySetting = { findUnique: jest.fn(), findMany: jest.fn(), upsert: jest.fn() };
    mockPrisma.follow = { findUnique: jest.fn() };
    mockPrisma.blockList = { findUnique: jest.fn(), findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() };
    mockPrisma.chatMessage = {
      findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(),
      create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn(),
    };
    mockPrisma.chatRoom = { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn() };
    mockPrisma.chatRoomMember = { upsert: jest.fn().mockResolvedValue({ id: 'member-1' }) };
    mockPrisma.chatStarredMessage = { upsert: jest.fn(), deleteMany: jest.fn(), findMany: jest.fn() };
    mockPrisma.chatPoll = { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() };
    mockPrisma.chatPollVote = { createMany: jest.fn(), deleteMany: jest.fn() };
    mockPrisma.chatPinnedRoom = { findMany: jest.fn(), findFirst: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn() };
    mockPrisma.chatReplyTemplate = { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), deleteMany: jest.fn(), count: jest.fn() };
    mockPrisma.user = { findUnique: jest.fn() };
    mockPrisma.userShowcase = { findUnique: jest.fn() };
    mockPrisma.order = { findUnique: jest.fn() };
    mockPrisma.userReport = { create: jest.fn() };
    mockPrisma.$transaction = jest.fn((ops: any[]) => Promise.all(ops.map((o) => (o?.then ? o : Promise.resolve(o)))));
  });

  // ---------- privasi ----------

  describe('getChatPrivacy / updateChatPrivacy', () => {
    it('mengembalikan default bila belum ada pengaturan', async () => {
      makeService();
      mockPrisma.privacySetting.findUnique.mockResolvedValue(null);
      await expect(service.getChatPrivacy('u1')).resolves.toEqual({ hideReadReceipts: false, dmPolicy: DmPolicy.EVERYONE });
    });

    it('menyimpan dmPolicy + hideReadReceipts', async () => {
      makeService();
      mockPrisma.privacySetting.upsert.mockResolvedValue({ hideReadReceipts: true, dmPolicy: DmPolicy.NONE });
      const result = await service.updateChatPrivacy('u1', { hideReadReceipts: true, dmPolicy: DmPolicy.NONE });
      expect(result).toEqual({ hideReadReceipts: true, dmPolicy: DmPolicy.NONE });
    });
  });

  // ---------- DM policy ----------

  describe('assertDmAllowed (via createInquiry/getOrCreateDm)', () => {
    it('DM ditolak bila target set NONE', async () => {
      makeService();
      mockPrisma.privacySetting.findUnique.mockResolvedValue({ dmPolicy: DmPolicy.NONE });
      await expect((service as any).assertDmAllowed('u1', 'u2')).rejects.toThrow(ForbiddenException);
    });

    it('FOLLOWING: ditolak bila target tidak follow pengirim', async () => {
      makeService();
      mockPrisma.privacySetting.findUnique.mockResolvedValue({ dmPolicy: DmPolicy.FOLLOWING });
      mockPrisma.follow.findUnique.mockResolvedValue(null);
      await expect((service as any).assertDmAllowed('u1', 'u2')).rejects.toThrow(ForbiddenException);
    });

    it('FOLLOWING: diizinkan bila target follow pengirim', async () => {
      makeService();
      mockPrisma.privacySetting.findUnique.mockResolvedValue({ dmPolicy: DmPolicy.FOLLOWING });
      mockPrisma.follow.findUnique.mockResolvedValue({ id: 'f1' });
      await expect((service as any).assertDmAllowed('u1', 'u2')).resolves.toBeUndefined();
    });

    it('EVERYONE (default): selalu diizinkan', async () => {
      makeService();
      mockPrisma.privacySetting.findUnique.mockResolvedValue(null);
      await expect((service as any).assertDmAllowed('u1', 'u2')).resolves.toBeUndefined();
    });
  });

  // ---------- hide read receipts ----------

  describe('hideReadReceipts', () => {
    it('filterReadAtForViewer menyembunyikan pembaca hidden dari lawan bicara', () => {
      const readAt = { 'user-1': 't1', 'user-2': 't2' };
      const filtered = filterReadAtForViewer(readAt, 'user-2', new Set(['user-1'])) as Record<string, string>;
      expect(filtered).toEqual({ 'user-2': 't2' });
    });

    it('pembaca hidden tetap melihat entrinya sendiri', () => {
      const readAt = { 'user-1': 't1', 'user-2': 't2' };
      const filtered = filterReadAtForViewer(readAt, 'user-1', new Set(['user-1'])) as Record<string, string>;
      expect(filtered).toEqual({ 'user-1': 't1', 'user-2': 't2' });
    });

    it('markAsRead hanya emit ke user sendiri bila hide aktif (bukan ke room)', async () => {
      makeService();
      mockPrisma.$executeRaw.mockResolvedValue(2);
      mockPrisma.privacySetting.findUnique.mockResolvedValue({ hideReadReceipts: true });
      mockPrisma.notification = { updateMany: jest.fn() };
      await service.markAsRead('user-1', 'room-1');
      expect(mockRealtime.emitToUser).toHaveBeenCalledWith('user-1', 'chat.read', expect.objectContaining({ roomId: 'room-1' }));
      expect(mockRealtime.emitToChatRoom).not.toHaveBeenCalled();
    });

    it('markAsRead emit ke room bila hide nonaktif', async () => {
      makeService();
      mockPrisma.$executeRaw.mockResolvedValue(1);
      mockPrisma.privacySetting.findUnique.mockResolvedValue({ hideReadReceipts: false });
      mockPrisma.notification = { updateMany: jest.fn() };
      await service.markAsRead('user-1', 'room-1');
      expect(mockRealtime.emitToChatRoom).toHaveBeenCalledWith('room-1', 'chat.read', expect.objectContaining({ userId: 'user-1' }));
    });
  });

  // ---------- translate ----------

  describe('translateMessage', () => {
    it('501 TRANSLATION_NOT_CONFIGURED bila provider kosong (fail closed)', async () => {
      makeService(); // tanpa translation service
      mockPrisma.chatMessage.findUnique.mockResolvedValue({ id: 'm1', roomId: 'room-1', content: 'halo', isDeleted: false, messageType: 'TEXT' });
      const err = await service.translateMessage('user-1', 'm1', 'en').catch((e) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect(err.getStatus()).toBe(501);
      expect(err.getResponse().code).toBe('TRANSLATION_NOT_CONFIGURED');
    });

    it('mendelegasikan ke provider bila dikonfigurasi', async () => {
      makeService({ translation: true });
      mockPrisma.chatMessage.findUnique.mockResolvedValue({ id: 'm1', roomId: 'room-1', content: 'halo', isDeleted: false, messageType: 'TEXT' });
      mockTranslation.translate.mockResolvedValue({ translatedText: 'hello', sourceLang: 'id' });
      const result = await service.translateMessage('user-1', 'm1', 'EN');
      expect(mockTranslation.translate).toHaveBeenCalledWith('halo', 'en');
      expect(result).toMatchObject({ messageId: 'm1', translatedText: 'hello' });
    });

    it('menolak pesan non-teks', async () => {
      makeService({ translation: true });
      mockPrisma.chatMessage.findUnique.mockResolvedValue({ id: 'm1', roomId: 'room-1', content: null, isDeleted: false, messageType: 'IMAGE' });
      await expect(service.translateMessage('user-1', 'm1', 'en')).rejects.toThrow(BadRequestException);
    });
  });

  // ---------- export ----------

  describe('exportRoom', () => {
    it('hanya anggota room yang boleh export (validateRoomAccess)', async () => {
      makeService();
      (service.validateRoomAccess as jest.Mock).mockRejectedValueOnce(new NotFoundException({ code: 'NOT_FOUND', message: 'Room not found' }));
      await expect(service.exportRoom('outsider', 'room-1', 'txt')).rejects.toThrow(NotFoundException);
    });

    it('menolak export melebihi batas 5000 pesan', async () => {
      makeService();
      mockPrisma.chatMessage.findMany.mockResolvedValue(new Array(5001).fill({ id: 'x' }));
      await expect(service.exportRoom('user-1', 'room-1', 'txt')).rejects.toThrow(BadRequestException);
    });

    it('menghasilkan txt', async () => {
      makeService();
      mockPrisma.chatMessage.findMany.mockResolvedValue([
        { id: 'm1', messageType: 'TEXT', content: 'hai', locationLabel: null, createdAt: new Date('2026-01-01T00:00:00Z'), sender: { fullName: 'Budi' } },
      ]);
      const result = await service.exportRoom('user-1', 'room-1', 'txt');
      expect(result.format).toBe('txt');
      expect(result.content as string).toContain('hai');
    });
  });

  // ---------- starred ----------

  describe('starred messages', () => {
    it('star menolak pesan di luar room (ownership/room validation)', async () => {
      makeService();
      mockPrisma.chatMessage.findFirst.mockResolvedValue(null);
      await expect(service.starMessage('user-1', 'room-1', 'mX')).rejects.toThrow(NotFoundException);
      expect(mockPrisma.chatStarredMessage.upsert).not.toHaveBeenCalled();
    });

    it('star + unstar', async () => {
      makeService();
      mockPrisma.chatMessage.findFirst.mockResolvedValue({ id: 'm1' });
      mockPrisma.chatStarredMessage.upsert.mockResolvedValue({ id: 's1' });
      await expect(service.starMessage('user-1', 'room-1', 'm1')).resolves.toEqual({ starred: true });
      mockPrisma.chatStarredMessage.deleteMany.mockResolvedValue({ count: 1 });
      await expect(service.unstarMessage('user-1', 'room-1', 'm1')).resolves.toEqual({ starred: false });
    });
  });

  // ---------- self room ----------

  describe('getOrCreateSelfRoom', () => {
    it('reuse room self yang sudah ada', async () => {
      makeService();
      mockPrisma.chatRoom.findFirst.mockResolvedValue({ id: 'self-1', status: 'ACTIVE' });
      const result = await service.getOrCreateSelfRoom('user-1') as any;
      expect(result.room.id).toBe('self-1');
      expect(result.room.isSelf).toBe(true);
      expect(mockPrisma.chatRoom.create).not.toHaveBeenCalled();
    });

    it('membuat room self baru bila belum ada', async () => {
      makeService();
      mockPrisma.chatRoom.findFirst.mockResolvedValue(null);
      mockPrisma.chatRoom.create.mockResolvedValue({ id: 'self-2', status: 'ACTIVE' });
      const result = await service.getOrCreateSelfRoom('user-1') as any;
      expect(result.room.id).toBe('self-2');
      expect(mockPrisma.chatRoom.create).toHaveBeenCalled();
    });
  });

  // ---------- lokasi & kartu ----------

  describe('location & card messages', () => {
    it('validateLocationMessage menolak koordinat invalid', () => {
      makeService();
      expect(() => (service as any).validateLocationMessage(null)).toThrow(BadRequestException);
      expect(() => (service as any).validateLocationMessage({ lat: 200, lng: 0 })).toThrow(BadRequestException);
      expect((service as any).validateLocationMessage({ lat: -6.2, lng: 106.8, label: ' Jakarta ' })).toEqual({ lat: -6.2, lng: 106.8, label: 'Jakarta' });
    });

    it('product card menolak showcase tidak aktif / milik orang luar', async () => {
      makeService();
      mockPrisma.userShowcase.findUnique.mockResolvedValue({ id: 's1', isActive: false });
      await expect((service as any).buildProductCardSnapshot('s1', roomContext(), 'user-1')).rejects.toThrow();
    });

    it('product card membuat snapshot harga/judul', async () => {
      makeService();
      mockPrisma.userShowcase.findUnique.mockResolvedValue({
        id: 's1', userId: 'user-2', title: 'Sepatu', priceMin: 100000, priceMax: 200000,
        isActive: true, visibility: 'PUBLIC', images: [{ imageUrl: 'https://x/img.jpg' }],
        user: { username: 'seller', fullName: 'Seller' },
      });
      const snap = await (service as any).buildProductCardSnapshot('s1', roomContext(), 'user-1');
      expect(snap.kind).toBe('PRODUCT_CARD');
      expect(snap.title).toBe('Sepatu');
      expect(snap.priceMin).toBe('100000');
    });

    it('order card menolak pihak luar order', async () => {
      makeService();
      mockPrisma.order.findUnique.mockResolvedValue({
        id: 'o1', orderId: 'ORD-1', title: 'X', status: 'PROCESSING', orderValue: BigInt(1000),
        buyerId: 'a', sellerId: 'b', deletedAt: null, buyer: { username: 'a' }, seller: { username: 'b' },
      });
      await expect((service as any).buildOrderCardSnapshot('o1', 'user-1')).rejects.toThrow();
    });
  });

  // ---------- polls ----------

  describe('polls', () => {
    it('menolak opsi kurang dari 2', async () => {
      makeService();
      await expect(service.createPoll('user-1', 'room-1', { question: 'Q?', options: ['satu'] } as never)).rejects.toThrow(BadRequestException);
      // Polling invalid tidak boleh membuat pesan POLL.
      expect(mockPrisma.chatMessage.create).not.toHaveBeenCalled();
    });

    it('createPoll membuat pesan POLL di thread + emit chat.new_message', async () => {
      makeService();
      mockPrisma.chatPoll.create.mockResolvedValue({ id: 'p1' });
      const pollRow = {
        id: 'p1', roomId: 'room-1', question: 'Makan apa?', options: ['Nasi', 'Mie'],
        allowMultiple: false, deadline: null, isClosed: false, createdAt: new Date(),
        createdBy: { userId: 'user-1', fullName: 'A' },
        votes: [
          { userId: 'user-2', optionIndex: 0 },
          { userId: 'user-2', optionIndex: 0 },
        ],
      };
      const rawMessage = {
        id: 'm1', roomId: 'room-1', messageType: 'POLL', content: 'Makan apa?',
        isEdited: false, editedAt: null, isDeleted: false, deletedAt: null,
        isPinned: false, pinnedAt: null, durationSeconds: null, forwardedFromId: null,
        readAt: null, ephemeralTtlSeconds: null, expiresAt: null, viewOnce: false,
        viewOnceViewedAt: null, locationLat: null, locationLng: null, locationLabel: null,
        cardSnapshot: null, pollId: 'p1', poll: pollRow,
        createdAt: new Date(), updatedAt: new Date(),
        replyToId: null, replyTo: null, forwardedFrom: null,
        sender: { id: 'user-1', userId: 'user-1', fullName: 'A', avatarUrl: null },
        attachments: [], reactions: [],
      };
      mockPrisma.chatMessage.create.mockResolvedValue(rawMessage);
      mockPrisma.chatRoom.update.mockResolvedValue({ id: 'room-1' });
      mockPrisma.chatPoll.findFirst.mockResolvedValue({ id: 'p1' });
      mockPrisma.chatPoll.findUnique.mockResolvedValue(pollRow);

      const result = (await service.createPoll('user-1', 'room-1', {
        question: 'Makan apa?',
        options: ['Nasi', 'Mie'],
      } as never)) as Record<string, unknown>;

      // Pesan POLL dibuat: pollId + content = question + sender.
      expect(mockPrisma.chatMessage.create).toHaveBeenCalledTimes(1);
      const createArg = mockPrisma.chatMessage.create.mock.calls[0][0];
      expect(createArg.data.messageType).toBe('POLL');
      expect(createArg.data.pollId).toBe('p1');
      expect(createArg.data.content).toBe('Makan apa?');
      expect(createArg.data.senderId).toBe('user-1');
      expect(createArg.data.roomId).toBe('room-1');
      // Room di-bump + unread counter lawan bicara.
      expect(mockPrisma.chatRoom.update).toHaveBeenCalled();
      expect(mockPrisma.chatRoomMember.upsert).toHaveBeenCalled();
      // Emit chat.new_message ke room (payload netral) + ke kedua user.
      expect(mockRealtime.emitToChatRoom).toHaveBeenCalledWith('room-1', 'chat.new_message', expect.anything());
      const roomPayload = mockRealtime.emitToChatRoom.mock.calls.find((c: unknown[]) => c[1] === 'chat.new_message')[2] as Record<string, unknown>;
      expect(roomPayload.messageType).toBe('POLL');
      expect(roomPayload.pollId).toBe('p1');
      expect((roomPayload.poll as Record<string, unknown>).question).toBe('Makan apa?');
      expect((roomPayload.poll as Record<string, unknown>).options).toEqual([
        { index: 0, text: 'Nasi', votes: 2 },
        { index: 1, text: 'Mie', votes: 0 },
      ]);
      expect(mockRealtime.emitToUser).toHaveBeenCalledWith('user-1', 'chat.new_message', expect.anything());
      expect(mockRealtime.emitToUser).toHaveBeenCalledWith('user-2', 'chat.new_message', expect.anything());
      // Return value TETAP objek poll (kompatibilitas API lama).
      expect(result.id).toBe('p1');
      expect(result.question).toBe('Makan apa?');
    });

    it('serializeMessage embed poll untuk pesan POLL (hitungan + myVotes)', () => {
      const pollRow = {
        id: 'p1', roomId: 'room-1', question: 'Makan apa?', options: ['Nasi', 'Mie'],
        allowMultiple: false, deadline: null, isClosed: false, createdAt: new Date(),
        createdBy: { userId: 'user-1', fullName: 'A' },
        votes: [
          { userId: 'user-2', optionIndex: 0 },
          { userId: 'user-1', optionIndex: 1 },
        ],
      };
      const rawMessage = {
        id: 'm1', roomId: 'room-1', messageType: 'POLL', content: 'Makan apa?',
        isEdited: false, editedAt: null, isDeleted: false, deletedAt: null,
        isPinned: false, pinnedAt: null, durationSeconds: null, forwardedFromId: null,
        readAt: null, ephemeralTtlSeconds: null, expiresAt: null, viewOnce: false,
        viewOnceViewedAt: null, locationLat: null, locationLng: null, locationLabel: null,
        cardSnapshot: null, pollId: 'p1', poll: pollRow,
        createdAt: new Date(), updatedAt: new Date(),
        replyToId: null, replyTo: null, forwardedFrom: null,
        sender: { id: 'user-1', userId: 'user-1', fullName: 'A', avatarUrl: null },
        attachments: [], reactions: [],
      };
      const view = serializeMessage(rawMessage as never, { viewerId: 'user-2' }) as unknown as Record<string, unknown>;
      expect(view.pollId).toBe('p1');
      const poll = view.poll as Record<string, unknown>;
      expect(poll.question).toBe('Makan apa?');
      expect(poll.options).toEqual([
        { index: 0, text: 'Nasi', votes: 1 },
        { index: 1, text: 'Mie', votes: 1 },
      ]);
      // myVotes dari sudut pandang viewer (user-2).
      expect(poll.myVotes).toEqual([0]);
      // Pesan non-POLL tidak embed poll.
      const textView = serializeMessage({ ...rawMessage, messageType: 'TEXT', pollId: null, poll: null } as never, {}) as unknown as Record<string, unknown>;
      expect(textView.poll).toBeNull();
    });

    it('replyTo pesan POLL menyertakan pollId', () => {
      const rawMessage = {
        id: 'm2', roomId: 'room-1', messageType: 'TEXT', content: 'Setuju',
        isEdited: false, editedAt: null, isDeleted: false, deletedAt: null,
        isPinned: false, pinnedAt: null, durationSeconds: null, forwardedFromId: null,
        readAt: null, ephemeralTtlSeconds: null, expiresAt: null, viewOnce: false,
        viewOnceViewedAt: null, locationLat: null, locationLng: null, locationLabel: null,
        cardSnapshot: null, pollId: null, poll: null,
        createdAt: new Date(), updatedAt: new Date(),
        replyToId: 'm1',
        replyTo: {
          id: 'm1', content: 'Makan apa?', messageType: 'POLL', isDeleted: false,
          pollId: 'p1', sender: { id: 'user-1', userId: 'user-1', fullName: 'A', avatarUrl: null },
          attachments: [],
        },
        forwardedFrom: null,
        sender: { id: 'user-2', userId: 'user-2', fullName: 'B', avatarUrl: null },
        attachments: [], reactions: [],
      };
      const view = serializeMessage(rawMessage as never, {}) as unknown as Record<string, unknown>;
      const replyTo = view.replyTo as Record<string, unknown>;
      expect(replyTo.messageType).toBe('POLL');
      expect(replyTo.pollId).toBe('p1');
      expect(replyTo.content).toBe('Makan apa?');
    });

    it('pesan POLL tidak bisa diedit (fail-closed)', async () => {
      makeService();
      mockPrisma.chatMessage.findFirst.mockResolvedValue({
        id: 'm1', senderId: 'user-1', content: 'Makan apa?', messageType: 'POLL', createdAt: new Date(),
      });
      await expect(service.editMessage('user-1', 'room-1', 'm1', 'baru')).rejects.toThrow(BadRequestException);
    });

    it('vote pada poll tertutup ditolak', async () => {
      makeService();
      mockPrisma.chatPoll.findFirst.mockResolvedValue({ id: 'p1', options: ['a', 'b'], allowMultiple: false, deadline: null, isClosed: true });
      await expect(service.votePoll('user-1', 'room-1', 'p1', [0])).rejects.toThrow(BadRequestException);
      expect(mockPrisma.chatPollVote.createMany).not.toHaveBeenCalled();
    });

    it('vote setelah deadline ditolak', async () => {
      makeService();
      mockPrisma.chatPoll.findFirst.mockResolvedValue({
        id: 'p1', options: ['a', 'b'], allowMultiple: false, deadline: new Date(Date.now() - 1000), isClosed: false,
      });
      await expect(service.votePoll('user-1', 'room-1', 'p1', [0])).rejects.toThrow(BadRequestException);
    });

    it('single-choice menolak >1 pilihan', async () => {
      makeService();
      mockPrisma.chatPoll.findFirst.mockResolvedValue({
        id: 'p1', options: ['a', 'b'], allowMultiple: false, deadline: null, isClosed: false,
      });
      await expect(service.votePoll('user-1', 'room-1', 'p1', [0, 1])).rejects.toThrow(BadRequestException);
    });

    it('single-choice mengganti suara lama; multi-choice menambah', async () => {
      makeService();
      mockPrisma.chatPoll.findFirst.mockResolvedValue({
        id: 'p1', options: ['a', 'b'], allowMultiple: false, deadline: null, isClosed: false,
      });
      mockPrisma.chatPollVote.deleteMany.mockResolvedValue({ count: 1 });
      mockPrisma.chatPollVote.createMany.mockResolvedValue({ count: 1 });
      mockPrisma.chatPoll.findUnique.mockResolvedValue({
        id: 'p1', roomId: 'room-1', question: 'Q', options: ['a', 'b'], allowMultiple: false,
        deadline: null, isClosed: false, createdAt: new Date(),
        createdBy: { userId: 'user-2', fullName: 'C' }, votes: [{ userId: 'user-1', optionIndex: 1 }],
      });
      await service.votePoll('user-1', 'room-1', 'p1', [1]);
      expect(mockPrisma.chatPollVote.deleteMany).toHaveBeenCalledWith({ where: { pollId: 'p1', userId: 'user-1' } });
      expect(mockPrisma.chatPollVote.createMany).toHaveBeenCalled();
    });
  });

  // ---------- pin room & reply template ----------

  describe('pin room & reply templates', () => {
    it('pin room menyinkron ke backend', async () => {
      makeService();
      mockPrisma.chatPinnedRoom.upsert.mockResolvedValue({ roomId: 'room-1', position: 0 });
      await service.pinChatRoom('user-1', 'room-1');
      expect(mockPrisma.chatPinnedRoom.upsert).toHaveBeenCalled();
      expect(mockRealtime.emitToUser).toHaveBeenCalledWith('user-1', 'chat.room_pinned', expect.anything());
    });

    it('unpin room', async () => {
      makeService();
      mockPrisma.chatPinnedRoom.deleteMany.mockResolvedValue({ count: 1 });
      await expect(service.unpinChatRoom('user-1', 'room-1')).resolves.toEqual({ unpinned: true });
    });

    it('template menolak shortcut duplikat', async () => {
      makeService();
      mockPrisma.chatReplyTemplate.count.mockResolvedValue(0);
      mockPrisma.chatReplyTemplate.findUnique.mockResolvedValue({ id: 't0' });
      await expect(service.createReplyTemplate('user-1', { shortcut: 'salam', text: 'Halo kak' })).rejects.toThrow();
    });

    it('template menolak melebihi 50 template/user', async () => {
      makeService();
      mockPrisma.chatReplyTemplate.count.mockResolvedValue(50);
      await expect(service.createReplyTemplate('user-1', { shortcut: 'x', text: 'y' })).rejects.toThrow(BadRequestException);
    });
  });

  // ---------- block/report dari room ----------

  describe('block/report dari menu room', () => {
    it('block di self chat ditolak', async () => {
      makeService();
      (service.validateRoomAccess as jest.Mock).mockResolvedValueOnce(roomContext({ counterpartId: 'user-1' }));
      await expect(service.blockCounterpartFromRoom('user-1', 'room-1')).rejects.toThrow(BadRequestException);
    });

    it('block counterpart membuat block + hapus follow', async () => {
      makeService();
      mockPrisma.blockList.findUnique.mockResolvedValue(null);
      mockPrisma.blockList.create.mockResolvedValue({ id: 'b1' });
      mockPrisma.follow = { deleteMany: jest.fn().mockResolvedValue({ count: 2 }) };
      const result = await service.blockCounterpartFromRoom('user-1', 'room-1');
      expect(result.message).toBe('User blocked successfully');
      expect(mockPrisma.blockList.create).toHaveBeenCalled();
    });

    it('report counterpart menautkan order room otomatis', async () => {
      makeService();
      (service.validateRoomAccess as jest.Mock).mockResolvedValueOnce(
        roomContext({ type: 'ORDER', order: { id: 'o1', orderId: 'ORD-1', status: 'PROCESSING', completedAt: null, cancelledAt: null, buyerId: 'user-1', sellerId: 'user-2' } }),
      );
      mockPrisma.userReport.create.mockResolvedValue({ id: 'r1' });
      const result = await service.reportCounterpartFromRoom('user-1', 'room-1', { category: 'SPAM', description: 'spam terus' } as never);
      expect(result.reportId).toBe('r1');
      expect(mockPrisma.userReport.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ relatedOrderId: 'o1', targetId: 'user-2' }) }),
      );
    });
  });

  // ---------- order events → system message ----------

  describe('handleOrderEvent (system message + auto-archive)', () => {
    function setupRoom() {
      mockPrisma.chatRoom.findUnique.mockResolvedValue({ id: 'room-1', initiatorId: 'user-1', counterpartId: 'user-2', type: 'ORDER', status: 'ACTIVE' });
      mockPrisma.chatMessage.create.mockResolvedValue({ id: 'sys-1', roomId: 'room-1', messageType: 'SYSTEM', content: 'x', senderId: null, createdAt: new Date() });
      mockPrisma.chatRoom.update.mockResolvedValue({});
      mockPrisma.chatRoomMember.upsert.mockResolvedValue({ id: 'm' });
    }

    it('ORDER_PAID memposting pesan sistem tanpa mengarsipkan', async () => {
      makeService();
      setupRoom();
      await service.handleOrderEvent('ORD-1', 'ORDER_PAID');
      expect(mockPrisma.chatMessage.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ messageType: 'SYSTEM' }) }),
      );
      expect(mockRealtime.emitToChatRoom).toHaveBeenCalledWith('room-1', 'chat.new_message', expect.anything());
      expect(mockPrisma.chatRoomMember.upsert).not.toHaveBeenCalled();
    });

    it('ORDER_COMPLETED mengarsipkan room untuk kedua pihak', async () => {
      makeService();
      setupRoom();
      await service.handleOrderEvent('ORD-1', 'ORDER_COMPLETED');
      expect(mockPrisma.chatRoomMember.upsert).toHaveBeenCalledTimes(2);
      const roomIds = mockPrisma.chatRoomMember.upsert.mock.calls.map((c: any) => c[0].where.roomId_userId.userId).sort();
      expect(roomIds).toEqual(['user-1', 'user-2']);
    });

    it('order tanpa room chat dilewati diam-diam', async () => {
      makeService();
      mockPrisma.chatRoom.findUnique.mockResolvedValue(null);
      await service.handleOrderEvent('ORD-9', 'ORDER_PAID');
      expect(mockPrisma.chatMessage.create).not.toHaveBeenCalled();
    });
  });

  // ---------- createOrderFromChat ----------

  describe('createOrderFromChat (escrow-only, tanpa jalur wallet direct)', () => {
    it('menolak room non-INQUIRY', async () => {
      makeService({ orders: true });
      (service.validateRoomAccess as jest.Mock).mockResolvedValueOnce(roomContext({ type: 'ORDER' }));
      await expect(
        service.createOrderFromChat('user-1', 'room-1', { title: 'X', description: 'Y', hargaSepakat: 10000 } as never),
      ).rejects.toThrow(BadRequestException);
      expect(mockOrdersService.createOrder).not.toHaveBeenCalled();
    });

    it('fail closed bila OrdersService tidak tersedia', async () => {
      makeService(); // tanpa orders
      await expect(
        service.createOrderFromChat('user-1', 'room-1', { title: 'X', description: 'Y', hargaSepakat: 10000 } as never),
      ).rejects.toThrow(HttpException);
    });

    it('mendelegasikan ke OrdersService.createOrder dengan inquiryRoomId (jalur escrow)', async () => {
      makeService({ orders: true });
      mockPrisma.user.findUnique.mockResolvedValue({ username: 'buyer1', isActive: true, isBanned: false });
      mockPrisma.blockList.findUnique.mockResolvedValue(null);
      mockPrisma.follow = { deleteMany: jest.fn() };
      mockOrdersService.createOrder.mockResolvedValue({ orderId: 'ORD-1', status: 'WAITING_PAYMENT', feeCalculation: {}, confirmationDeadlineAt: new Date() });
      mockPrisma.chatRoom.findUnique.mockResolvedValue({ id: 'room-1', initiatorId: 'user-1', counterpartId: 'user-2', type: 'INQUIRY', status: 'ACTIVE', deletedAt: null, subject: null, order: null });

      const result = await service.createOrderFromChat('user-1', 'room-1', {
        title: 'Sepatu', description: 'baru', hargaSepakat: 150000, qty: 2, role: 'SELLER',
      } as never) as any;

      expect(mockOrdersService.createOrder).toHaveBeenCalledTimes(1);
      const [actorId, orderInput] = mockOrdersService.createOrder.mock.calls[0];
      expect(actorId).toBe('user-1');
      expect(orderInput.inquiryRoomId).toBe('room-1');
      expect(orderInput.orderValue).toBe(300000);
      expect(orderInput.counterpartUsername).toBe('buyer1');
      // TIDAK ada pemanggilan wallet transfer langsung / pembuatan order manual.
      expect(mockPrisma.order.create).toBeUndefined();
      expect(result.order.orderId).toBe('ORD-1');
    });
  });

  // ---------- purge service ----------

  describe('ChatEphemeralPurgeService', () => {
    const makePurgeDeps = (attachments: Array<{ messageId: string; fileUrl: string | null; thumbnailUrl: string | null }> = []) => {
      const prisma: any = {
        chatMessage: {
          findMany: jest.fn().mockResolvedValue([
            { id: 'm1', roomId: 'r1', room: { order: { status: 'PROCESSING' } } },
            { id: 'm2', roomId: 'r1', room: { order: { status: 'DISPUTED' } } },
          ]),
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        chatAttachment: {
          findMany: jest.fn().mockResolvedValue(attachments),
        },
      };
      const realtime: any = { emitToChatRoom: jest.fn() };
      const upload: any = {
        fileKeyFromStoredUrl: jest.fn((url: string) => {
          const m = /\/uploads\/(.+)$/.exec(url);
          return m ? `uploads/${m[1]}` : null;
        }),
        deleteStoredFile: jest.fn().mockResolvedValue(true),
      };
      return { prisma, realtime, upload };
    };

    it('melewati pesan di order DISPUTED; menghormati limit', async () => {
      const { prisma, realtime, upload } = makePurgeDeps();
      const purge = new ChatEphemeralPurgeService(prisma as never, realtime as never, upload as never);
      const result = await purge.purgeNow(10);
      expect(prisma.chatMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 10 }));
      expect(prisma.chatMessage.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['m1'] } } });
      expect(result).toEqual({ purged: 1, skippedDisputed: 1 });
    });

    it('LOW (SEC-D): menghapus file fisik lampiran sebelum hard-delete DB', async () => {
      const { prisma, realtime, upload } = makePurgeDeps([
        { messageId: 'm1', fileUrl: 'https://api.kahade.id/uploads/chat-attachments/u1/a.mp3', thumbnailUrl: null },
        { messageId: 'm2', fileUrl: 'https://api.kahade.id/uploads/chat-attachments/u1/b.mp3', thumbnailUrl: null },
      ]);
      const purge = new ChatEphemeralPurgeService(prisma as never, realtime as never, upload as never);
      await purge.purgeNow(10);
      // m1 (PROCESSING) -> file dihapus; m2 (DISPUTED) -> diskip total.
      expect(upload.deleteStoredFile).toHaveBeenCalledTimes(1);
      expect(upload.deleteStoredFile).toHaveBeenCalledWith('uploads/chat-attachments/u1/a.mp3');
      expect(prisma.chatMessage.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['m1'] } } });
    });

    it('LOW (SEC-D): pesan dipertahankan bila file gagal dihapus (retry berikutnya)', async () => {
      const { prisma, realtime, upload } = makePurgeDeps([
        { messageId: 'm1', fileUrl: 'https://api.kahade.id/uploads/chat-attachments/u1/a.mp3', thumbnailUrl: null },
      ]);
      upload.deleteStoredFile.mockResolvedValue(false);
      const purge = new ChatEphemeralPurgeService(prisma as never, realtime as never, upload as never);
      const result = await purge.purgeNow(10);
      expect(prisma.chatMessage.deleteMany).not.toHaveBeenCalled();
      expect(realtime.emitToChatRoom).not.toHaveBeenCalled();
      expect(result).toEqual({ purged: 0, skippedDisputed: 1 });
    });
  });

  // ---------- ChatOrderHooks ----------

  describe('ChatOrderHooks', () => {
    it('emit tanpa handler = no-op (tidak throw)', () => {
      expect(() => ChatOrderHooks.emit('ORD-1', 'ORDER_PAID')).not.toThrow();
    });

    it('handler error tidak merembet ke pemanggil (best-effort)', async () => {
      ChatOrderHooks.register(async () => { throw new Error('boom'); });
      expect(() => ChatOrderHooks.emit('ORD-1', 'ORDER_PAID')).not.toThrow();
      // beri kesempatan fire-and-forget catch berjalan
      await new Promise((r) => setTimeout(r, 10));
    });
  });
});
