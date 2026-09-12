import { ReportFlagService, REPORT_FLAG_THRESHOLD, REPORT_FLAG_WINDOW_HOURS } from './report-flag.service';
import { PrismaService } from '../../prisma/prisma.service';

const TARGET_ID = 'target-1';

const mockPrisma: any = {
  userReport: { findMany: jest.fn() },
  user: { updateMany: jest.fn() },
};

function reporters(count: number) {
  return Array.from({ length: count }, (_, i) => ({ reporterId: `reporter-${i + 1}` }));
}

describe('ReportFlagService — agregasi laporan jadi sinyal moderasi (Section 6)', () => {
  let service: ReportFlagService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.userReport.findMany.mockResolvedValue([]);
    mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
    service = new ReportFlagService(mockPrisma as never);
  });

  describe('threshold', () => {
    it('is 3 distinct reporters inside a 24h window', () => {
      expect(REPORT_FLAG_THRESHOLD).toBe(3);
      expect(REPORT_FLAG_WINDOW_HOURS).toBe(24);
    });

    it('does not flag a target below the threshold', async () => {
      mockPrisma.userReport.findMany.mockResolvedValue(reporters(2));
      await expect(service.evaluateTarget(TARGET_ID)).resolves.toEqual({
        flaggedForReview: false,
        distinctReporters: 2,
      });
      expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('flags a target as soon as the threshold is reached', async () => {
      mockPrisma.userReport.findMany.mockResolvedValue(reporters(3));
      await expect(service.evaluateTarget(TARGET_ID)).resolves.toEqual({
        flaggedForReview: true,
        distinctReporters: 3,
      });
      expect(mockPrisma.user.updateMany).toHaveBeenCalledTimes(1);
    });

    it('flags a target above the threshold and reports the real count', async () => {
      mockPrisma.userReport.findMany.mockResolvedValue(reporters(7));
      await expect(service.evaluateTarget(TARGET_ID)).resolves.toEqual({
        flaggedForReview: true,
        distinctReporters: 7,
      });
    });

    it('does not flag a target with no reports at all', async () => {
      await expect(service.evaluateTarget(TARGET_ID)).resolves.toEqual({
        flaggedForReview: false,
        distinctReporters: 0,
      });
      expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('what gets counted', () => {
    it('counts DISTINCT reporters so one person cannot flag anyone', async () => {
      await service.evaluateTarget(TARGET_ID);
      expect(mockPrisma.userReport.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: { reporterId: true },
          distinct: ['reporterId'],
        }),
      );
    });

    it('scopes the count to the reported target', async () => {
      await service.evaluateTarget(TARGET_ID);
      expect(mockPrisma.userReport.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ targetId: TARGET_ID }) }),
      );
    });

    it('only looks at the trailing 24h window', async () => {
      await service.evaluateTarget(TARGET_ID);
      const since = mockPrisma.userReport.findMany.mock.calls[0][0].where.createdAt.gte as Date;
      const expected = Date.now() - REPORT_FLAG_WINDOW_HOURS * 60 * 60 * 1000;
      expect(Math.abs(since.getTime() - expected)).toBeLessThan(5000);
    });

    it('ignores reports older than the window', async () => {
      // DB sudah memfilter lewat createdAt.gte; service hanya menghitung baris
      // yang kembali. Dua baris -> di bawah ambang -> tidak ada flag.
      mockPrisma.userReport.findMany.mockResolvedValue(reporters(2));
      const result = await service.evaluateTarget(TARGET_ID);
      expect(result.flaggedForReview).toBe(false);
    });
  });

  describe('how the flag is written', () => {
    it('writes a conditional updateMany so repeated reports stay idempotent', async () => {
      mockPrisma.userReport.findMany.mockResolvedValue(reporters(5));
      await service.evaluateTarget(TARGET_ID);
      const args = mockPrisma.user.updateMany.mock.calls[0][0];
      expect(args.where).toEqual({ id: TARGET_ID, flaggedForReview: false, deletedAt: null });
      expect(args.data.flaggedForReview).toBe(true);
      expect(args.data.flaggedForReviewAt).toBeInstanceOf(Date);
    });

    it('does not shift flaggedForReviewAt once the target is already flagged', async () => {
      mockPrisma.userReport.findMany.mockResolvedValue(reporters(9));
      mockPrisma.user.updateMany.mockResolvedValue({ count: 0 });
      // Laporan ke-4..ke-N tidak boleh menggeser waktu flag pertama.
      await expect(service.evaluateTarget(TARGET_ID)).resolves.toEqual({
        flaggedForReview: true,
        distinctReporters: 9,
      });
      expect(mockPrisma.user.updateMany).toHaveBeenCalledTimes(1);
    });

    it('never flags a soft-deleted account', async () => {
      mockPrisma.userReport.findMany.mockResolvedValue(reporters(4));
      await service.evaluateTarget(TARGET_ID);
      expect(mockPrisma.user.updateMany.mock.calls[0][0].where.deletedAt).toBeNull();
    });
  });

  describe('best-effort contract', () => {
    it('never throws when the report query fails', async () => {
      mockPrisma.userReport.findMany.mockRejectedValue(new Error('db down'));
      await expect(service.evaluateTarget(TARGET_ID)).resolves.toEqual({
        flaggedForReview: false,
        distinctReporters: 0,
      });
    });

    it('never throws when writing the flag fails', async () => {
      mockPrisma.userReport.findMany.mockResolvedValue(reporters(4));
      mockPrisma.user.updateMany.mockRejectedValue(new Error('db down'));
      // Laporan sudah tersimpan; kegagalan agregasi tidak boleh membatalkannya.
      await expect(service.evaluateTarget(TARGET_ID)).resolves.toBeDefined();
    });

    it('takes no automatic action beyond the flag', async () => {
      mockPrisma.userReport.findMany.mockResolvedValue(reporters(50));
      await service.evaluateTarget(TARGET_ID);
      // Tidak ada ban, suspend, atau pembatasan lain: hanya dua kolom flag.
      const data = mockPrisma.user.updateMany.mock.calls[0][0].data;
      expect(Object.keys(data).sort()).toEqual(['flaggedForReview', 'flaggedForReviewAt']);
      expect(data.isBanned).toBeUndefined();
      expect(data.isActive).toBeUndefined();
    });
  });
});
