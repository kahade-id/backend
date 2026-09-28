import { ChatService } from '../chat.service';

/**
 * Batch 139 BE-API2 — item 122: `urlExpiresAt` (ISO absolut) pada attachment
 * yang fileUrl-nya di-sign, dihitung saat response/read-time.
 */
describe('ChatService getRoomAttachments — urlExpiresAt (item 122)', () => {
  const USER_ID = 'user-1';
  const ROOM_ID = 'room-1';
  const STABLE_URL = 'https://api.kahade.id/uploads/chat-attachments/user-1/foto.jpg';
  const SIGNED_URL = 'https://api.kahade.id/dl/signed?token=abc';

  const mockPrisma: any = {};
  const mockUpload: any = { generateDownloadUrl: jest.fn() };
  let service: ChatService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.chatRoom = {
      findUnique: jest.fn().mockResolvedValue({
        id: ROOM_ID,
        type: 'INQUIRY',
        status: 'ACTIVE',
        subject: 'Tanya stok',
        initiatorId: USER_ID,
        counterpartId: 'user-2',
        order: null,
      }),
    };
    mockPrisma.user = {
      findUnique: jest.fn().mockResolvedValue({ isActive: true, isBanned: false }),
    };
    mockPrisma.chatAttachment = {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'att-1',
          fileName: 'foto.jpg',
          fileSize: 1234,
          mimeType: 'image/jpeg',
          fileUrl: STABLE_URL,
          thumbnailUrl: null,
          createdAt: new Date(),
          message: { id: 'msg-1', sender: { userId: USER_ID } },
        },
      ]),
      count: jest.fn().mockResolvedValue(1),
    };
    mockUpload.generateDownloadUrl.mockResolvedValue(SIGNED_URL);
    service = new ChatService(
      mockPrisma as never,
      {} as never,
      { get: jest.fn() } as never,
      {} as never,
      {} as never,
      mockUpload as never,
      undefined,
      undefined,
    );
  });

  it('menyertakan urlExpiresAt ISO ~300 detik dari sekarang untuk URL yang di-sign', async () => {
    const before = Date.now();
    const result = (await service.getRoomAttachments(USER_ID, ROOM_ID, 1, 10)) as any;
    const att = result.data[0];
    expect(att.fileUrl).toBe(SIGNED_URL);
    expect(typeof att.urlExpiresAt).toBe('string');
    const expiresMs = new Date(att.urlExpiresAt).getTime();
    // TTL 300 detik, toleransi 10 detik untuk waktu eksekusi test.
    expect(expiresMs - before).toBeGreaterThan(290_000);
    expect(expiresMs - before).toBeLessThanOrEqual(310_000);
    expect(mockUpload.generateDownloadUrl).toHaveBeenCalledWith(expect.stringContaining('chat-attachments'), 300);
  });

  it('urlExpiresAt=null bila URL tidak di-sign (raw passthrough)', async () => {
    mockPrisma.chatAttachment.findMany.mockResolvedValue([
      {
        id: 'att-2',
        fileName: 'x.bin',
        fileSize: 10,
        mimeType: 'application/octet-stream',
        fileUrl: 'https://cdn.lain.com/file.bin',
        thumbnailUrl: null,
        createdAt: new Date(),
        message: { id: 'msg-2', sender: { userId: USER_ID } },
      },
    ]);
    const result = (await service.getRoomAttachments(USER_ID, ROOM_ID, 1, 10)) as any;
    const att = result.data[0];
    expect(att.fileUrl).toBe('https://cdn.lain.com/file.bin');
    expect(att.urlExpiresAt).toBeNull();
    expect(mockUpload.generateDownloadUrl).not.toHaveBeenCalled();
  });

  it('urlExpiresAt=null (bukan expiry palsu) bila signing gagal', async () => {
    mockUpload.generateDownloadUrl.mockRejectedValue(new Error('signing down'));
    const result = (await service.getRoomAttachments(USER_ID, ROOM_ID, 1, 10)) as any;
    const att = result.data[0];
    expect(att.urlExpiresAt).toBeNull();
  });
});
