/**
 * GAP-F (G450): spec tests — moderator hide/unhide vs owner, appeal flow,
 * audit event, RBAC, dan sinkronisasi state.
 *
 * Service memakai raw SQL; prisma dimock pada level $queryRaw/$executeRaw
 * dengan urutan panggilan yang sama seperti implementasi.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { AdminQaModerationService } from './admin-qa-moderation.service';
import { maskUsername } from './qa-moderation.types';

function makePrismaMock() {
  const mock: any = {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn().mockResolvedValue(1),
    notification: { create: jest.fn().mockResolvedValue({ id: 'n1' }) },
    emitNotificationCreated: jest.fn(),
  };
  // Transaksi mengeksekusi callback terhadap mock yang sama supaya
  // assertion $queryRaw/$executeRaw tetap berlaku di dalam $transaction.
  mock.$transaction = jest.fn().mockImplementation((cb: (db: unknown) => unknown) => cb(mock));
  return mock;
}

type PrismaMock = ReturnType<typeof makePrismaMock>;

describe('AdminQaModerationService (G450)', () => {
  let prisma: PrismaMock;
  let service: AdminQaModerationService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new AdminQaModerationService(prisma as never);
    jest.clearAllMocks();
    prisma.$executeRaw.mockResolvedValue(1);
    prisma.notification.create.mockResolvedValue({ id: 'n1' });
  });

  const targetRow = (overrides = {}) => ({
    id: 'q1',
    author_id: 'user-asker',
    author_username: 'budi123',
    is_hidden: false,
    hidden_by_type: null,
    ...overrides,
  });

  describe('moderatorHide — jalur moderator terpisah dari owner', () => {
    it('menyembunyikan target + mencatat hidden_by_type=MODERATOR + event audit', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([targetRow()]);

      const res = await service.moderatorHide('admin-1', 'QUESTION', 'q1', 'SPAM', 'catatan internal');

      expect(res).toMatchObject({ id: 'q1', isHidden: true, hiddenByType: 'MODERATOR', reasonCode: 'SPAM' });
      // UPDATE menandai hidden_by_type MODERATOR + hidden_by_admin_id
      const updateCall = prisma.$executeRaw.mock.calls[0][0];
      const updateSql = String(updateCall.sql ?? updateCall);
      expect(updateSql).toContain('MODERATOR');
      // Event audit HIDDEN tercatat (G437)
      const eventCall = prisma.$executeRaw.mock.calls.find((call: unknown[]) =>
        String((call[0] as { sql?: unknown } | undefined)?.sql ?? call[0]).includes('qa_moderation_events'),
      );
      expect(eventCall).toBeDefined();
      expect(eventCall![0].values).toContain('HIDDEN');
    });

    it('menolak reasonCode yang tidak dikenal', async () => {
      await expect(service.moderatorHide('admin-1', 'QUESTION', 'q1', 'BOGUS')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('menolak hide ganda (sudah hidden)', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([targetRow({ is_hidden: true, hidden_by_type: 'MODERATOR' })]);
      await expect(service.moderatorHide('admin-1', 'QUESTION', 'q1', 'SPAM')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('mengirim notifikasi netral ke penulis tanpa menyebut pelapor', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([targetRow()]);
      await service.moderatorHide('admin-1', 'COMMENT', 'c1', 'HARASSMENT');
      expect(prisma.notification.create).toHaveBeenCalled();
      const body = String(prisma.notification.create.mock.calls[0][0].data.body);
      expect(body).not.toMatch(/pelapor|reporter/i);
      expect(body).toMatch(/panduan komunitas/i);
    });
  });

  describe('moderatorUnhide — sinkronisasi state', () => {
    it('menolak unhide konten yang di-hide pemilik (hak self-service pemilik)', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([targetRow({ is_hidden: true, hidden_by_type: 'OWNER' })]);
      await expect(service.moderatorUnhide('admin-1', 'QUESTION', 'q1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('unhide konten hide-moderator + event UNHIDDEN', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([targetRow({ is_hidden: true, hidden_by_type: 'MODERATOR' })]);
      const res = await service.moderatorUnhide('admin-1', 'QUESTION', 'q1');
      expect(res).toMatchObject({ id: 'q1', isHidden: false });
      const eventCall = prisma.$executeRaw.mock.calls.find((call: unknown[]) =>
        String((call[0] as { sql?: unknown } | undefined)?.sql ?? call[0]).includes('qa_moderation_events'),
      );
      expect(eventCall![0].values).toContain('UNHIDDEN');
    });

    it('menolak unhide konten yang tidak hidden', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([targetRow()]);
      await expect(service.moderatorUnhide('admin-1', 'QUESTION', 'q1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('bulk (G442)', () => {
    it('menolak bulk tanpa confirm=true (G441)', async () => {
      await expect(
        service.bulkHide('admin-1', 'QUESTION', ['q1'], 'SPAM', undefined, false),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('melaporkan hasil parsial per item', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([targetRow({ id: 'q1' })]) // q1 ok
        .mockResolvedValueOnce([targetRow({ id: 'q2', is_hidden: true, hidden_by_type: 'MODERATOR' })]); // q2 gagal
      const res = (await service.bulkHide('admin-1', 'QUESTION', ['q1', 'q2'], 'SPAM', undefined, true)) as {
        succeeded: number;
        failed: number;
        results: Array<{ id: string; ok: boolean }>;
      };
      expect(res.succeeded).toBe(1);
      expect(res.failed).toBe(1);
      expect(res.results.find(r => r.id === 'q1')?.ok).toBe(true);
      expect(res.results.find(r => r.id === 'q2')?.ok).toBe(false);
    });
  });

  describe('redact (G434)', () => {
    it('menolak bila tidak ada pola PII', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([{ text: 'Halo, apa kabar?', answer: null }]);
      await expect(service.redact('admin-1', 'QUESTION', 'q1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('menyimpan redacted_text + event REDACTED tanpa mengubah original', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([{ text: 'Hubungi 081234567890 ya', answer: null }]);
      const res = (await service.redact('admin-1', 'QUESTION', 'q1')) as { redactedText: string };
      expect(res.redactedText).toContain('[NOMOR-HP-DISENSOR]');
      expect(res.redactedText).not.toContain('081234567890');
      const updateCall = prisma.$executeRaw.mock.calls.find((call: unknown[]) =>
        String((call[0] as { sql?: unknown } | undefined)?.sql ?? call[0]).includes('redacted_text'),
      );
      expect(updateCall).toBeDefined();
    });
  });

  describe('delete dua langkah (G435)', () => {
    it('menolak approve oleh requester yang sama', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([
        { id: 'dr1', target_type: 'QUESTION', target_id: 'q1', requested_by_admin_id: 'admin-1', status: 'PENDING' },
      ]);
      await expect(service.decideDeleteRequest('admin-1', 'dr1', true)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('approve oleh SUPER_ADMIN lain → hard delete + event DELETED', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([
          { id: 'dr1', target_type: 'QUESTION', target_id: 'q1', requested_by_admin_id: 'admin-1', status: 'PENDING' },
        ])
        .mockResolvedValueOnce([targetRow()]); // loadTarget untuk notifikasi
      const res = await service.decideDeleteRequest('admin-2', 'dr1', true, 'pelanggaran berat');
      expect(res).toMatchObject({ requestId: 'dr1', status: 'APPROVED' });
      const deleteCall = prisma.$executeRaw.mock.calls.find((call: unknown[]) =>
        String((call[0] as { sql?: unknown } | undefined)?.sql ?? call[0]).includes('DELETE FROM profile_questions'),
      );
      expect(deleteCall).toBeDefined();
      const eventCall = prisma.$executeRaw.mock.calls.find((call: unknown[]) =>
        String((call[0] as { sql?: unknown } | undefined)?.sql ?? call[0]).includes('qa_moderation_events'),
      );
      expect(eventCall![0].values).toContain('DELETED');
    });
  });

  describe('appeal flow (G436)', () => {
    const appealRow = {
      id: 'ap1', target_type: 'QUESTION', target_id: 'q1',
      appellant_id: 'user-asker', status: 'PENDING', reason: 'Saya tidak melanggar',
    };

    it('menolak review oleh moderator yang melakukan hide', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([appealRow])
        .mockResolvedValueOnce([{ actor_admin_id: 'admin-mod' }]);
      await expect(service.reviewAppeal('admin-mod', 'ap1', 'APPROVED')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('APPROVED oleh reviewer lain → unhide + event APPEAL_APPROVED', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([appealRow])
        .mockResolvedValueOnce([{ actor_admin_id: 'admin-mod' }])
        // reviewAppeal memuat target sekali, lalu moderatorUnhide memuat ulang.
        .mockResolvedValueOnce([targetRow({ is_hidden: true, hidden_by_type: 'MODERATOR' })])
        .mockResolvedValueOnce([targetRow({ is_hidden: true, hidden_by_type: 'MODERATOR' })]);
      const res = await service.reviewAppeal('admin-2', 'ap1', 'APPROVED');
      expect(res).toMatchObject({ appealId: 'ap1', status: 'APPROVED' });
      const unhideCall = prisma.$executeRaw.mock.calls.find((call: unknown[]) =>
        String((call[0] as { sql?: unknown } | undefined)?.sql ?? call[0]).includes('"isHidden" = FALSE'),
      );
      expect(unhideCall).toBeDefined();
      const eventCall = prisma.$executeRaw.mock.calls.find((call: unknown[]) =>
        ((call[0] as { values?: unknown } | undefined)?.values as unknown[] | undefined)?.includes('APPEAL_APPROVED'),
      );
      expect(eventCall).toBeDefined();
    });

    it('REJECTED → keputusan moderasi tetap, event APPEAL_REJECTED', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([appealRow])
        .mockResolvedValueOnce([{ actor_admin_id: 'admin-mod' }]);
      const res = await service.reviewAppeal('admin-2', 'ap1', 'REJECTED', 'tetap melanggar');
      expect(res).toMatchObject({ status: 'REJECTED' });
      const unhideCall = prisma.$executeRaw.mock.calls.find((call: unknown[]) =>
        String((call[0] as { sql?: unknown } | undefined)?.sql ?? call[0]).includes('"isHidden" = FALSE'),
      );
      expect(unhideCall).toBeUndefined();
    });
  });

  describe('G433 — masking username di list', () => {
    it('maskUsername menyamarkan sebagian', () => {
      expect(maskUsername('budi123')).toBe('bu•••');
      expect(maskUsername(null)).toBeNull();
      expect(maskUsername(undefined)).toBeNull();
    });
  });
});
