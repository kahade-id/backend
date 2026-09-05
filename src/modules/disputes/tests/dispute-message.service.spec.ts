import { Test, TestingModule } from '@nestjs/testing';
import { DisputeMessageService } from '../dispute-message.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { UploadService } from '../../upload/upload.service';

/*
 * C-21: `getMessages` paginated `orderBy: { createdAt: 'asc' }` with a positive `take`, so page 1
 * was the OLDEST window. Its only caller — `apps/mobile/app/dispute/[id].tsx:117` — sends no page
 * or limit, so it was pinned to the first `limit` messages permanently: the socket handler and the
 * 15 s refetch both re-requested that same first page. Past `limit` messages the mediation chat
 * froze for both parties, while POST /messages and the `dispute.new_message` event kept succeeding.
 *
 * The fix pages newest-first at the DB and flips the returned page back to ascending, so page 1 is
 * the newest window and page 2 is the one before it — the same direction the admin endpoint's
 * cursor ("Muat Lebih Lama") already walks.
 */

const mockPrisma = {
  dispute: { findFirst: jest.fn() },
  disputeMessage: { findMany: jest.fn(), count: jest.fn(), create: jest.fn() },
};

const mockRealtime = { emitToUser: jest.fn() };
const mockUpload = { verifyEvidenceFileKeysBatch: jest.fn(), getFileSize: jest.fn(), cleanupFileKeys: jest.fn() };

const DISPUTE_ROW = {
  id: 'disp-1',
  disputeId: 'D-1',
  status: 'OPEN',
  order: { buyerId: 'buyer-1', sellerId: 'seller-1', orderId: 'ORD-1' },
};

// Oldest → newest. The DB returns these in whatever order the query asks for; the mock below
// honours `orderBy` so the assertions test the real ordering contract, not a fixed array.
const ALL_MESSAGES = Array.from({ length: 25 }, (_, i) => ({
  id: `msg-${i + 1}`,
  disputeId: 'disp-1',
  senderId: i % 2 === 0 ? 'buyer-1' : 'seller-1',
  message: `message ${i + 1}`,
  createdAt: new Date(2026, 0, 1, 0, i),
}));

describe('DisputeMessageService', () => {
  let service: DisputeMessageService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.dispute.findFirst.mockResolvedValue(DISPUTE_ROW);
    mockPrisma.disputeMessage.count.mockResolvedValue(ALL_MESSAGES.length);
    mockUpload.verifyEvidenceFileKeysBatch.mockResolvedValue([]);
    mockUpload.getFileSize.mockResolvedValue(1024);
    mockUpload.cleanupFileKeys.mockResolvedValue({ deleted: 1, errors: [] });
    mockPrisma.disputeMessage.create.mockResolvedValue({ id: 'msg-created', message: 'hello' });
    mockPrisma.disputeMessage.findMany.mockImplementation(
      (args: { orderBy: { createdAt: 'asc' | 'desc' }; skip: number; take: number }) => {
        const ordered =
          args.orderBy.createdAt === 'desc' ? [...ALL_MESSAGES].reverse() : [...ALL_MESSAGES];
        return Promise.resolve(ordered.slice(args.skip, args.skip + args.take));
      },
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DisputeMessageService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RealtimeService, useValue: mockRealtime },
        { provide: UploadService, useValue: mockUpload },
      ],
    }).compile();
    service = module.get<DisputeMessageService>(DisputeMessageService);
  });

  describe('getMessages — page 1 is the newest window (C-21)', () => {
    it('returns the most recent messages on the default first page, not the oldest', async () => {
      const res = (await service.getMessages('D-1', 'buyer-1', 1, 20)) as {
        messages: Array<{ id: string }>;
      };

      // 25 messages, limit 20 -> newest 20 are msg-6..msg-25.
      expect(res.messages).toHaveLength(20);
      expect(res.messages[res.messages.length - 1].id).toBe('msg-25');
      expect(res.messages[0].id).toBe('msg-6');
    });

    it('still returns the page in ascending order so the UI renders oldest-to-newest', async () => {
      const res = (await service.getMessages('D-1', 'buyer-1', 1, 20)) as {
        messages: Array<{ createdAt: Date }>;
      };

      const times = res.messages.map((m) => m.createdAt.getTime());
      expect(times).toEqual([...times].sort((a, b) => a - b));
    });

    it('walks backwards in time as the page number grows', async () => {
      const page2 = (await service.getMessages('D-1', 'buyer-1', 2, 20)) as {
        messages: Array<{ id: string }>;
      };

      // The 5 remaining older messages, still ascending.
      expect(page2.messages.map((m) => m.id)).toEqual(['msg-1', 'msg-2', 'msg-3', 'msg-4', 'msg-5']);
    });

    it('keeps the page/limit/total/totalPages contract unchanged', async () => {
      const res = (await service.getMessages('D-1', 'buyer-1', 1, 20)) as Record<string, unknown>;

      expect(res).toMatchObject({ total: 25, page: 1, limit: 20, totalPages: 2 });
    });

    it('clamps a zero limit instead of returning an empty page with Infinity totalPages', async () => {
      const res = (await service.getMessages('D-1', 'buyer-1', 1, 0)) as {
        messages: unknown[];
        totalPages: number;
      };

      expect(res.messages.length).toBeGreaterThan(0);
      expect(Number.isFinite(res.totalPages)).toBe(true);
    });
  });

  describe('sendMessage attachment safety', () => {
    const attachment = { fileKey: 'uploads/dispute-evidence/buyer-1/a.jpg', fileName: 'a.jpg', fileType: 'image/jpeg', fileSize: 1024 };

    it('authorizes the participant before checking or consuming attachments', async () => {
      mockPrisma.dispute.findFirst.mockResolvedValue({ ...DISPUTE_ROW, order: { ...DISPUTE_ROW.order, buyerId: 'someone-else' } });
      await expect(service.sendMessage('D-1', 'outsider', 'hello', [attachment])).rejects.toMatchObject({ response: { code: 'FORBIDDEN' } });
      expect(mockUpload.verifyEvidenceFileKeysBatch).not.toHaveBeenCalled();
    });

    it('cleans successful batch keys when another attachment fails validation', async () => {
      mockUpload.verifyEvidenceFileKeysBatch.mockResolvedValue([
        { fileKey: attachment.fileKey, fileType: attachment.fileType, status: 'ok' },
        { fileKey: 'uploads/dispute-evidence/buyer-1/b.jpg', fileType: 'image/jpeg', status: 'error' },
      ]);
      const second = { ...attachment, fileKey: 'uploads/dispute-evidence/buyer-1/b.jpg' };
      await expect(service.sendMessage('D-1', 'buyer-1', 'hello', [attachment, second])).rejects.toMatchObject({ response: { code: 'UPLOAD_NOT_CONFIRMED' } });
      expect(mockUpload.cleanupFileKeys).toHaveBeenCalledWith('buyer-1', [attachment.fileKey]);
    });

    it('does not turn a committed message into a retry when realtime emit fails', async () => {
      mockUpload.verifyEvidenceFileKeysBatch.mockResolvedValue([{ fileKey: attachment.fileKey, fileType: attachment.fileType, status: 'ok' }]);
      mockRealtime.emitToUser.mockImplementation(() => { throw new Error('socket unavailable'); });
      await expect(service.sendMessage('D-1', 'buyer-1', 'hello', [attachment])).resolves.toMatchObject({ id: 'msg-created' });
    });
  });
});
