/**
 * Bug #1 — RESIDU data lama (regresi).
 *
 * Dua bentuk data yang sudah ada di produksi sebelum perbaikan ini:
 *
 * 1. `chat_attachments.file_url` berisi **signed URL** hasil upload
 *    (`https://api.kahade.id/v1/upload/s?key=…&exp=…&sig=…`, TTL 900s) — inilah
 *    bentuk yang dipersist sebelum `0f3caee`. Sebelumnya `extractChatFileKey`
 *    tidak mengenali bentuk ini dan menghasilkan key palsu
 *    `uploads/v1/upload/s`, sehingga `generateDownloadUrl` melempar
 *    `INVALID_FILE_TYPE` → `toReadableAttachment` mengembalikan **URL kosong**
 *    dan lampiran lama tetap rusak meski endpoint unduh sudah diperbaiki.
 *
 * 2. Pesan baru yang dikirim dengan signed URL yang SUDAH kedaluwarsa (upload
 *    besar > 15 menit di jaringan seluler) — dulu ditolak 400
 *    "invalid or expired signature" sehingga pesan gagal terkirim, padahal
 *    fileKey-nya sah dan tetap diverifikasi lewat validateStorageUrl +
 *    validateOwnership (folder chat-attachments milik pengirim).
 */
import { ChatService } from '../chat.service';
import { generateSignedStorageUrl, type SignedStorageUrlOptions } from '../chat-test.utils';

const USER_ID = 'cluser00000000000000001';
const OTHER_USER = 'cluser00000000000000002';
const ROOM_ID = 'clxroom00000000000000001';
const FILE_KEY = `uploads/chat-attachments/${USER_ID}/1759800000000-AbC1-foto.jpg`;
const SIGNING_SECRET = 'unit-test-storage-signing-secret-0123456789';

const buildSignedUrl = (
  fileKey: string,
  opts: SignedStorageUrlOptions,
): string => generateSignedStorageUrl(fileKey, SIGNING_SECRET, opts);

describe('Bug #1 residu — signed URL lama di DB & signed URL kedaluwarsa saat dikirim', () => {
  const mockPrisma: any = {};
  const mockUpload: any = {};
  let service: ChatService;

  const makeService = (configValues: Record<string, string | undefined> = {}) =>
    new ChatService(
      mockPrisma as never,
      {} as never,
      {
        get: jest.fn((key: string) =>
          configValues[key] !== undefined
            ? configValues[key]
            : key === 'app.storagePublicUrl'
              ? 'https://api.kahade.id/uploads'
              : undefined,
        ),
      } as never,
      {} as never,
      {} as never,
      mockUpload as never,
      undefined,
      undefined,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.chatRoom = {
      findUnique: jest.fn().mockResolvedValue({
        id: ROOM_ID,
        type: 'INQUIRY',
        status: 'ACTIVE',
        subject: 'Tanya stok',
        initiatorId: USER_ID,
        counterpartId: OTHER_USER,
        order: null,
      }),
    };
    mockPrisma.user = {
      findUnique: jest.fn().mockResolvedValue({ isActive: true, isBanned: false }),
    };
    mockPrisma.chatAttachment = {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    };
    mockUpload.generateDownloadUrl = jest
      .fn()
      .mockResolvedValue(`https://api.kahade.id/v1/upload/s?key=${encodeURIComponent(FILE_KEY)}&exp=9999999999&sig=fresh`);
    service = makeService();
  });

  it('fileUrl lama berupa signed URL → di-sign ULANG dari fileKey di query (bukan URL kosong)', async () => {
    // Bentuk persis yang dipersist pra-0f3caee (sig mungkin sudah kedaluwarsa).
    const legacySignedUrl = buildSignedUrl(FILE_KEY, {
      expiresInSeconds: -3600, // kedaluwarsa 1 jam lalu
      secret: SIGNING_SECRET,
    });
    mockPrisma.chatAttachment.findMany.mockResolvedValue([
      {
        id: 'att-legacy',
        fileName: 'foto.jpg',
        fileSize: 4096,
        mimeType: 'image/jpeg',
        fileUrl: legacySignedUrl,
        thumbnailUrl: null,
        createdAt: new Date(),
        message: { id: 'msg-legacy', sender: { userId: USER_ID } },
      },
    ]);

    const result = (await service.getRoomAttachments(USER_ID, ROOM_ID, 1, 10)) as any;
    const att = result.data[0];

    // Dulu: fileUrl '' (rusak permanen). Sekarang: signed URL segar dari fileKey.
    expect(att.fileUrl).not.toBe('');
    expect(mockUpload.generateDownloadUrl).toHaveBeenCalledWith(FILE_KEY, 300);
    expect(att.fileUrl).toContain('sig=fresh');
    expect(typeof att.urlExpiresAt).toBe('string');
  });

  it('fileUrl / thumbnailUrl lama berupa signed URL → keduanya di-sign ulang', async () => {
    mockPrisma.chatAttachment.findMany.mockResolvedValue([
      {
        id: 'att-legacy-video',
        fileName: 'klip.mp4',
        fileSize: 4096,
        mimeType: 'video/mp4',
        fileUrl: buildSignedUrl(FILE_KEY, { secret: SIGNING_SECRET }),
        thumbnailUrl: buildSignedUrl(
          `uploads/chat-attachments/${USER_ID}/1759800000000-AbC1-thumb.jpg`,
          { secret: SIGNING_SECRET },
        ),
        createdAt: new Date(),
        message: { id: 'msg-legacy-video', sender: { userId: USER_ID } },
      },
    ]);

    const result = (await service.getRoomAttachments(USER_ID, ROOM_ID, 1, 10)) as any;
    const att = result.data[0];

    expect(att.fileUrl).toContain('sig=fresh');
    expect(att.thumbnailUrl).toContain('sig=fresh');
    expect(mockUpload.generateDownloadUrl).toHaveBeenCalledTimes(2);
  });

  it('signed URL milik host lain TIDAK diekstrak (tetap diteruskan apa adanya)', async () => {
    const foreign = 'https://evil.example.com/v1/upload/s?key=uploads/chat-attachments/x/y.jpg&exp=1&sig=aa';
    mockPrisma.chatAttachment.findMany.mockResolvedValue([
      {
        id: 'att-foreign',
        fileName: 'x.jpg',
        fileSize: 4096,
        mimeType: 'image/jpeg',
        fileUrl: foreign,
        thumbnailUrl: null,
        createdAt: new Date(),
        message: { id: 'msg-foreign', sender: { userId: USER_ID } },
      },
    ]);

    const result = (await service.getRoomAttachments(USER_ID, ROOM_ID, 1, 10)) as any;
    expect(result.data[0].fileUrl).toBe(foreign);
    expect(mockUpload.generateDownloadUrl).not.toHaveBeenCalled();
  });

  it('signed URL dengan key tidak aman (path traversal) tidak diekstrak', async () => {
    const unsafe = `https://api.kahade.id/v1/upload/s?key=${encodeURIComponent('uploads/../../etc/passwd')}&exp=1&sig=aa`;
    mockPrisma.chatAttachment.findMany.mockResolvedValue([
      {
        id: 'att-unsafe',
        fileName: 'x.jpg',
        fileSize: 4096,
        mimeType: 'image/jpeg',
        fileUrl: unsafe,
        thumbnailUrl: null,
        createdAt: new Date(),
        message: { id: 'msg-unsafe', sender: { userId: USER_ID } },
      },
    ]);

    const result = (await service.getRoomAttachments(USER_ID, ROOM_ID, 1, 10)) as any;
    expect(result.data[0].fileUrl).toBe(unsafe);
    expect(mockUpload.generateDownloadUrl).not.toHaveBeenCalled();
  });

  describe('normalizeAttachmentUrl — pesan baru dengan signed URL kedaluwarsa', () => {
    const normalize = (rawUrl: string) =>
      (service as any).normalizeAttachmentUrl(USER_ID, rawUrl, 'Attachment file URL') as string;

    beforeEach(() => {
      mockUpload.verifySignedDownload = jest.fn().mockReturnValue(null); // sig kadaluarsa/rusak
    });

    it('signed URL kedaluwarsa dari user sendiri → fileKey mentah (pesan tetap terkirim)', () => {
      const expired = buildSignedUrl(FILE_KEY, { secret: SIGNING_SECRET, expiresInSeconds: -10 });
      expect(normalize(expired)).toBe(FILE_KEY);
    });

    it('signed URL kedaluwarsa MILIK ORANG LAIN → ditolak 400', () => {
      const foreignKey = `uploads/chat-attachments/${OTHER_USER}/1759800000000-XyZ1-foto.jpg`;
      const expired = buildSignedUrl(foreignKey, { secret: SIGNING_SECRET, expiresInSeconds: -10 });
      expect(() => normalize(expired)).toThrow(/does not belong to this user/i);
    });

    it('signed URL dengan key tidak aman → ditolak 400', () => {
      const unsafe = `https://api.kahade.id/v1/upload/s?key=${encodeURIComponent('uploads/chat-attachments/x/../../secret.txt')}&exp=1&sig=aa`;
      expect(() => normalize(unsafe)).toThrow(/does not belong to this user|invalid path|invalid or expired signature/i);
    });

    it('sig VALID tetap dinormalisasi seperti sebelumnya (jalur utama tidak berubah)', () => {
      mockUpload.verifySignedDownload.mockReturnValue(FILE_KEY);
      const valid = buildSignedUrl(FILE_KEY, { secret: SIGNING_SECRET });
      expect(normalize(valid)).toBe(FILE_KEY);
    });
  });
});
