import { ChatService } from '../chat.service';

/**
 * Batch 139 BE-API2 — item 116 (isPinned per room) & item 117 (query param q).
 */
describe('ChatService getRooms — isPinned & search q', () => {
  const mockPrisma: any = {};
  const mockRealtime: any = {
    areUsersOnline: jest.fn().mockResolvedValue({}),
    getLastSeen: jest.fn().mockResolvedValue(null),
    emitToUser: jest.fn(),
  };
  const mockConfig: any = { get: jest.fn() };
  const mockVerificationBadge: any = { getSealTierMap: jest.fn().mockResolvedValue(new Map()) };
  const mockNotifications: any = {};

  let service: ChatService;

  function roomRow(overrides: Record<string, unknown> = {}) {
    return {
      room_id: 'room-1',
      room_type: 'INQUIRY',
      room_status: 'ACTIVE',
      room_subject: 'Tanya stok',
      is_archived: false,
      room_created_at: new Date(),
      room_updated_at: new Date(),
      member_archived: null,
      member_muted: null,
      member_muted_until: null,
      order_id: null,
      order_title: null,
      order_status: null,
      initiator_user_id: 'USR-1',
      initiator_internal_id: 'user-1',
      initiator_full_name: 'Andi',
      initiator_username: 'andi',
      initiator_avatar_url: null,
      counterpart_user_id: 'USR-2',
      counterpart_internal_id: 'user-2',
      counterpart_full_name: 'Budi',
      counterpart_username: 'budi',
      counterpart_avatar_url: null,
      last_msg_id: null,
      last_msg_content: null,
      last_msg_type: null,
      last_msg_sender_user_id: null,
      last_msg_sender_internal_id: null,
      last_msg_created_at: null,
      unread_count: BigInt(0),
      pinned_count: BigInt(0),
      ...overrides,
    };
  }

  function makeService(rows: any[]) {
    // $queryRaw dipakai sebagai tagged template: argumen pertama adalah
    // TemplateStringsArray. Bedakan kueri list vs count dari teks SQL-nya.
    mockPrisma.$queryRaw = jest.fn((strings: TemplateStringsArray, ..._values: unknown[]) => {
      const sql = strings[0] ?? '';
      if (sql.includes('COUNT(*)')) return Promise.resolve([{ count: BigInt(rows.length) }]);
      return Promise.resolve(rows);
    });
    service = new ChatService(
      mockPrisma as never,
      mockRealtime as never,
      mockConfig as never,
      mockVerificationBadge as never,
      mockNotifications as never,
      undefined,
      undefined,
      undefined,
    );
  }

  function capturedValues(): unknown[] {
    const calls = (mockPrisma.$queryRaw as jest.Mock).mock.calls as unknown[][];
    return calls.flatMap((c) => (c as unknown[]).slice(1));
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.chatPinnedRoom = { findMany: jest.fn().mockResolvedValue([]) };
    mockPrisma.user = { findMany: jest.fn().mockResolvedValue([]) };
  });

  it('item 116: menyertakan isPinned=true hanya untuk room yang di-pin viewer', async () => {
    mockPrisma.chatPinnedRoom.findMany.mockResolvedValue([{ roomId: 'room-1' }]);
    makeService([roomRow({ room_id: 'room-1' }), roomRow({ room_id: 'room-2' })]);
    const res = (await service.getRooms('user-1', {})) as any;
    expect(res.data[0]).toMatchObject({ id: 'room-1', isPinned: true });
    expect(res.data[1]).toMatchObject({ id: 'room-2', isPinned: false });
    // Urutan tidak berubah (tetap urutan SQL).
    expect(res.data.map((r: any) => r.id)).toEqual(['room-1', 'room-2']);
  });

  it('item 116: isPinned=false untuk semua bila viewer tidak mem-pin apa pun', async () => {
    makeService([roomRow()]);
    const res = (await service.getRooms('user-1', {})) as any;
    expect(res.data[0].isPinned).toBe(false);
  });

  it('item 117: q diteruskan sebagai pola LIKE ke kedua kueri SQL', async () => {
    makeService([roomRow()]);
    await service.getRooms('user-1', { q: 'budi' });
    const values = capturedValues();
    // Pola pencarian terikat sebagai bound parameter di list + count query
    // (6x per query: cek IS NULL + 5 kolom ILIKE).
    expect(values.filter((v) => v === '%budi%').length).toBe(12);
    const sqlTexts = ((mockPrisma.$queryRaw as jest.Mock).mock.calls as unknown[][]).map(
      (c) => (c[0] as TemplateStringsArray).join('?'),
    );
    for (const sql of sqlTexts) {
      expect(sql).toContain('ILIKE');
    }
  });

  it('item 117: karakter wildcard dari user di-escape (100% tidak cocok semua)', async () => {
    makeService([roomRow()]);
    await service.getRooms('user-1', { q: '100%' });
    const values = capturedValues();
    expect(values).toContain('%100\\%%');
  });

  it('item 117: tanpa q, kondisi pencarian nonaktif (NULL)', async () => {
    makeService([roomRow()]);
    await service.getRooms('user-1', {});
    const values = capturedValues();
    expect(values.filter((v) => v === null)).not.toHaveLength(0);
    // Tidak ada pola LIKE non-null yang terikat.
    expect(values.some((v) => typeof v === 'string' && v.startsWith('%') && v.endsWith('%'))).toBe(false);
  });
});
