/**
 * GAP-F (G449/G450): spec user-side report & appeal (QaReportService).
 *
 * - G431: endpoint ter-autentikasi untuk melapor (antren terpisah qa_reports).
 * - G436: appeal hanya untuk hide MODERATOR; hanya penulis/pemilik profil.
 * - G449: IDOR — pelapor tidak bisa melapor konten sendiri; banding hanya
 *   oleh pihak yang berhak.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { QaReportService } from '../qa-report.service';

function makePrismaMock() {
  return {
    profileQuestion: { findUnique: jest.fn() },
    profileQuestionComment: { findUnique: jest.fn() },
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
}

type PrismaMock = ReturnType<typeof makePrismaMock>;

describe('QaReportService (G431/G436/G449)', () => {
  let prisma: PrismaMock;
  let service: QaReportService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new QaReportService(prisma as never);
    jest.clearAllMocks();
    prisma.$executeRaw.mockResolvedValue(1);
  });

  describe('reportQuestion (G431)', () => {
    it('menerima laporan atas konten orang lain', async () => {
      prisma.profileQuestion.findUnique.mockResolvedValue({ id: 'q1', askerId: 'userB' });
      prisma.$queryRaw.mockResolvedValueOnce([{ id: 'rep1' }]);
      const res = await service.reportQuestion('userA', 'q1', 'SPAM', 'spam nih');
      expect(res).toMatchObject({ reportId: 'rep1', status: 'PENDING' });
    });

    it('menolak melapor konten sendiri (IDOR/self)', async () => {
      prisma.profileQuestion.findUnique.mockResolvedValue({ id: 'q1', askerId: 'userA' });
      await expect(service.reportQuestion('userA', 'q1', 'SPAM')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('404 bila pertanyaan tidak ada', async () => {
      prisma.profileQuestion.findUnique.mockResolvedValue(null);
      await expect(service.reportQuestion('userA', 'qX', 'SPAM')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('menolak laporan duplikat terbuka (unique partial index → 409)', async () => {
      prisma.profileQuestion.findUnique.mockResolvedValue({ id: 'q1', askerId: 'userB' });
      prisma.$queryRaw.mockRejectedValueOnce({ code: '23505' });
      await expect(service.reportQuestion('userA', 'q1', 'SPAM')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('menolak reasonCode tidak valid', async () => {
      await expect(service.reportQuestion('userA', 'q1', 'BOGUS')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('reportComment (G431)', () => {
    it('menerima laporan komentar orang lain', async () => {
      prisma.profileQuestionComment.findUnique.mockResolvedValue({ id: 'c1', authorId: 'userB' });
      prisma.$queryRaw.mockResolvedValueOnce([{ id: 'rep2' }]);
      const res = await service.reportComment('userA', 'c1', 'HARASSMENT');
      expect(res).toMatchObject({ reportId: 'rep2', status: 'PENDING' });
    });

    it('menolak melapor komentar sendiri', async () => {
      prisma.profileQuestionComment.findUnique.mockResolvedValue({ id: 'c1', authorId: 'userA' });
      await expect(service.reportComment('userA', 'c1', 'SPAM')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('submitAppeal (G436)', () => {
    const hiddenByMod = {
      id: 'q1', is_hidden: true, hidden_by_type: 'MODERATOR',
      writer_id: 'userA', owner_id: 'userB',
    };

    it('penulis bisa banding atas hide moderator', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([hiddenByMod]) // load target
        .mockResolvedValueOnce([]) // tidak ada appeal pending
        .mockResolvedValueOnce([{ id: 'ap1' }]); // insert
      const res = await service.submitAppeal('userA', 'QUESTION', 'q1', 'Saya tidak melanggar aturan apapun');
      expect(res).toMatchObject({ appealId: 'ap1', status: 'PENDING' });
      const eventCall = prisma.$executeRaw.mock.calls.find(call =>
        String(call[0].sql ?? call[0]).includes('APPEAL_SUBMITTED'),
      );
      expect(eventCall).toBeDefined();
    });

    it('pemilik profil juga bisa banding', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([hiddenByMod])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'ap2' }]);
      const res = await service.submitAppeal('userB', 'QUESTION', 'q1', 'Konten ini wajar menurut saya sebagai pemilik profil');
      expect(res).toMatchObject({ appealId: 'ap2', status: 'PENDING' });
    });

    it('menolak banding atas hide OWNER (bukan moderator)', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([
        { ...hiddenByMod, hidden_by_type: 'OWNER' },
      ]);
      await expect(
        service.submitAppeal('userA', 'QUESTION', 'q1', 'Alasan banding yang cukup panjang'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('menolak banding konten yang tidak disembunyikan', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([
        { ...hiddenByMod, is_hidden: false, hidden_by_type: null },
      ]);
      await expect(
        service.submitAppeal('userA', 'QUESTION', 'q1', 'Alasan banding yang cukup panjang'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('pihak ketiga (bukan penulis/pemilik) ditolak — 403 (IDOR)', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([hiddenByMod]);
      await expect(
        service.submitAppeal('userC', 'QUESTION', 'q1', 'Alasan banding yang cukup panjang'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('menolak alasan banding terlalu pendek', async () => {
      await expect(service.submitAppeal('userA', 'QUESTION', 'q1', 'ga adil')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('menolak appeal duplikat yang masih pending', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([hiddenByMod])
        .mockResolvedValueOnce([{ id: 'apX' }]);
      await expect(
        service.submitAppeal('userA', 'QUESTION', 'q1', 'Alasan banding yang cukup panjang'),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
