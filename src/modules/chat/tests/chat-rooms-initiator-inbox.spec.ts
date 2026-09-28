import { ChatService } from '../chat.service';

/**
 * Wave 3 P0 — "Room DM hilang dari inbox initiator".
 *
 * Hasil investigasi (bukan bug filter): room DM E2E (cmui3at1...) tidak
 * muncul di inbox Agung karena membership-nya DIARSIPKAN via
 * PUT /v1/chat/rooms/:id/archive (terbukti di nginx access log, 200 OK) —
 * dan room yang terarsip memang disembunyikan dari daftar default by design.
 * "Self-pair" di ?type=INQUIRY adalah fitur "Pesan tersimpan"
 * (getOrCreateSelfRoom), bukan anomali.
 *
 * Test regresi ini mengunci perilaku yang benar:
 * 1. Filter participant mencakup KEDUA sisi pasangan kanonis
 *    (initiatorId / counterpartId disimpan terurut abjad — posisi viewer
 *    tidak menentukan keterlihatan).
 * 2. Room terarsip disembunyikan dari daftar default, muncul dengan
 *    ?archived=true.
 * 3. Room self (pesan tersimpan) ditandai isSelf=true di daftar.
 */
describe('ChatService getRooms — initiator inbox & archived & isSelf', () => {
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
      room_subject: null,
      is_archived: false,
      room_created_at: new Date(),
      room_updated_at: new Date(),
      member_archived: false,
      member_muted: null,
      member_muted_until: null,
      order_id: null,
      order_title: null,
      order_status: null,
      initiator_user_id: 'USR-AGUNG',
      initiator_internal_id: 'agung-id',
      initiator_full_name: 'Agung',
      initiator_username: 'agung',
      initiator_avatar_url: null,
      counterpart_user_id: 'USR-DARMA',
      counterpart_internal_id: 'darma-id',
      counterpart_full_name: 'Darma',
      counterpart_username: 'darma',
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
    mockPrisma.$queryRaw = jest.fn((strings: TemplateStringsArray, ..._values: unknown[]) => {
      const sql = strings[0] ?? '';
      if (sql.includes('COUNT(*)')) return Promise.resolve([{ count: BigInt(rows.length) }]);
      return Promise.resolve(rows);
    });
    mockPrisma.chatPinnedRoom = { findMany: jest.fn().mockResolvedValue([]) };
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

  it('room DM muncul untuk viewer di sisi initiatorId (posisi kanonis pertama)', async () => {
    // 'aaa-agung' < 'zzz-darma' → canonical: initiatorId=agung.
    makeService([roomRow({ initiator_internal_id: 'aaa-agung', counterpart_internal_id: 'zzz-darma' })]);
    const res = (await service.getRooms('aaa-agung', {})) as any;
    expect(res.data).toHaveLength(1);
    expect(res.data[0]).toMatchObject({ id: 'room-1', isSelf: false });
    // otherUser = lawan bicara (darma), bukan diri sendiri.
    expect(res.data[0].otherUser.username).toBe('darma');
  });

  it('room DM muncul untuk viewer di sisi counterpartId (posisi kanonis kedua)', async () => {
    // 'aaa-agung' < 'mmm-viewer': viewer tersimpan sebagai counterpartId.
    makeService([roomRow({ initiator_internal_id: 'aaa-agung', counterpart_internal_id: 'mmm-viewer' })]);
    const res = (await service.getRooms('mmm-viewer', {})) as any;
    expect(res.data).toHaveLength(1);
    expect(res.data[0].otherUser.username).toBe('agung');
  });

  it('predikat SQL memakai OR di kedua kolom pasangan (bukan filter satu sisi)', async () => {
    makeService([roomRow()]);
    await service.getRooms('agung-id', {});
    const sqlTexts = ((mockPrisma.$queryRaw as jest.Mock).mock.calls as unknown[][]).map((c) =>
      (c[0] as TemplateStringsArray).join('?'),
    );
    for (const sql of sqlTexts) {
      expect(sql).toContain('cr."initiatorId" = ?');
      expect(sql).toContain('OR');
      expect(sql).toContain('cr."counterpartId" = ?');
    }
  });

  it('room terarsip disembunyikan dari daftar default (by design)', async () => {
    // Simulasi hasil SQL untuk ?archived=true vs default: service hanya
    // memetakan baris yang dikembalikan query; query memfilter via
    // COALESCE(cm."isArchived", false) = archivedOnly.
    makeService([roomRow({ member_archived: true })]);
    const archivedRes = (await service.getRooms('agung-id', { archived: true })) as any;
    expect(archivedRes.data[0]).toMatchObject({ id: 'room-1', isArchived: true });

    const sqlTexts = ((mockPrisma.$queryRaw as jest.Mock).mock.calls as unknown[][]).map((c) =>
      (c[0] as TemplateStringsArray).join('?'),
    );
    for (const sql of sqlTexts) {
      expect(sql).toContain('COALESCE(cm."isArchived", false) = ?');
    }
    const values = ((mockPrisma.$queryRaw as jest.Mock).mock.calls as unknown[][]).flatMap((c) =>
      (c as unknown[]).slice(1),
    );
    expect(values).toContain(true); // archivedOnly=true terikat sebagai parameter
  });

  it('room "Pesan tersimpan" ditandai isSelf=true di daftar', async () => {
    makeService([
      roomRow({
        room_id: 'self-room',
        initiator_internal_id: 'agung-id',
        counterpart_internal_id: 'agung-id',
        initiator_username: 'agung',
        counterpart_username: 'agung',
      }),
    ]);
    const res = (await service.getRooms('agung-id', { type: 'INQUIRY' })) as any;
    expect(res.data[0]).toMatchObject({ id: 'self-room', isSelf: true });
  });
});
