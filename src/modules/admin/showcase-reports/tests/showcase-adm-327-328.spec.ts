/**
 * ADM-327 — GET /v1/admin/showcase-reports/metrics (ringkasan moderasi).
 * ADM-328 — POST /v1/admin/showcase-reports/bulk-review (bulk dismiss /
 * under_review, maks 50, confirm wajib, hasil parsial).
 *
 * Cakupan:
 * - ADM-327: agregat dikembalikan sebagai number (bigint dari raw SQL
 *   dikonversi), avgResolutionHours dibulatkan 1 desimal, reasonDistribution
 *   berisi { reason, count }.
 * - ADM-328: confirm !== true → 400 BULK_CONFIRM_REQUIRED; takedown di
 *   level DTO ditolak (IsIn hanya dismiss/under_review); ids > 50 ditolak
 *   DTO; hasil parsial: item gagal tidak menggagalkan item lain; setiap
 *   item lewat jalur reviewShowcaseReport (dimock per item).
 */
import 'reflect-metadata';
import { AdminRole } from '@prisma/client';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AdminShowcaseReportsService } from '../admin-showcase-reports.service';
import { BulkReviewShowcaseReportsDto } from '../dto/bulk-review-showcase-reports.dto';

function codeOf(err: unknown): string | undefined {
  if (err && typeof (err as { getResponse?: unknown }).getResponse === 'function') {
    const res = (err as { getResponse: () => unknown }).getResponse();
    if (res && typeof res === 'object') return (res as { code?: string }).code;
  }
  return undefined;
}

function makePrismaMock() {
  const prisma: any = {
    $queryRaw: jest.fn(),
  };
  prisma.$transaction = jest.fn(async (cb: any) => cb(prisma));
  return prisma;
}

function makeService(prisma: any) {
  const auditLog = { logAdminAction: jest.fn(), logUserAction: jest.fn() };
  const uploadService: any = {};
  const service = new AdminShowcaseReportsService(prisma, auditLog as never, uploadService);
  return { service, auditLog };
}

describe('ADM-327 getMetrics', () => {
  it('mengembalikan agregat dengan angka number (bigint dikonversi)', async () => {
    const prisma = makePrismaMock();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ open_reports: 3n, under_review: 2n }])
      .mockResolvedValueOnce([
        { action: 'TAKEDOWN', count: 5n },
        { action: 'DISMISSED', count: 7n },
      ])
      .mockResolvedValueOnce([{ avg_seconds: 7200, resolved_count: 12n }])
      .mockResolvedValueOnce([
        { reason: 'SPAM', count: 4n },
        { reason: 'FRAUD', count: 1n },
      ])
      .mockResolvedValueOnce([{ pending_appeals: 2n }]);
    const { service } = makeService(prisma);
    const res = (await service.getMetrics()) as Record<string, unknown>;

    expect(res.openReports).toBe(3);
    expect(res.underReview).toBe(2);
    expect(res.takedownsLast30d).toBe(5);
    expect(res.dismissedLast30d).toBe(7);
    expect(res.restrictsLast30d).toBe(0);
    expect(res.reopensLast30d).toBe(0);
    expect(res.resolvedLast30d).toBe(12);
    expect(res.avgResolutionHours).toBe(2);
    expect(res.pendingAppeals).toBe(2);
    expect(res.reasonDistribution).toEqual([
      { reason: 'SPAM', count: 4 },
      { reason: 'FRAUD', count: 1 },
    ]);
  });

  it('avgResolutionHours null bila tidak ada laporan terselesaikan', async () => {
    const prisma = makePrismaMock();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ open_reports: 0n, under_review: 0n }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ avg_seconds: null, resolved_count: 0n }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ pending_appeals: 0n }]);
    const { service } = makeService(prisma);
    const res = (await service.getMetrics()) as Record<string, unknown>;
    expect(res.avgResolutionHours).toBeNull();
    expect(res.reasonDistribution).toEqual([]);
  });
});

describe('ADM-324 getAssignCandidates', () => {
  it('mengembalikan kandidat dengan openAssignments sebagai number', async () => {
    const prisma = makePrismaMock();
    prisma.$queryRaw.mockResolvedValueOnce([
      { id: 'a1', full_name: 'Admin Satu', role: 'SUPER_ADMIN', open_assignments: 2n },
      { id: 'a2', full_name: 'Admin Dua', role: 'CUSTOMER_SUPPORT', open_assignments: 0n },
    ]);
    const { service } = makeService(prisma);
    const res = (await service.getAssignCandidates()) as Record<string, unknown>;
    expect(res.candidates).toEqual([
      { id: 'a1', fullName: 'Admin Satu', role: 'SUPER_ADMIN', openAssignments: 2 },
      { id: 'a2', fullName: 'Admin Dua', role: 'CUSTOMER_SUPPORT', openAssignments: 0 },
    ]);
  });

  it('query memfilter role/isActive/deletedAt dan join assignment terbuka', async () => {
    const prisma = makePrismaMock();
    prisma.$queryRaw.mockResolvedValueOnce([]);
    const { service } = makeService(prisma);
    await service.getAssignCandidates();
    const sql = String(prisma.$queryRaw.mock.calls[0][0].strings.join(' '));
    expect(sql).toContain('SUPER_ADMIN');
    expect(sql).toContain('CUSTOMER_SUPPORT');
    expect(sql).toContain('isActive');
    expect(sql).toContain('deletedAt');
    expect(sql).toContain('unassignedAt');
  });
});

describe('ADM-328 bulkReviewShowcaseReports', () => {
  it('confirm !== true → 400 BULK_CONFIRM_REQUIRED', async () => {
    const { service } = makeService(makePrismaMock());
    const err = await service
      .bulkReviewShowcaseReports('admin-1', '127.0.0.1', AdminRole.SUPER_ADMIN, ['r1'], 'dismiss', undefined, false)
      .catch((e: unknown) => e);
    expect(codeOf(err)).toBe('BULK_CONFIRM_REQUIRED');
  });

  it('hasil parsial: item gagal tidak menggagalkan item lain', async () => {
    const { service } = makeService(makePrismaMock());
    const spy = jest
      .spyOn(service, 'reviewShowcaseReport')
      .mockImplementation(async (reportId: string) => {
        if (reportId === 'r-bad') throw new Error('Sudah diselesaikan');
        return { message: 'ok', reportId, status: 'DISMISSED' as never };
      });
    const res = (await service.bulkReviewShowcaseReports(
      'admin-1',
      '127.0.0.1',
      AdminRole.SUPER_ADMIN,
      ['r-ok', 'r-bad', 'r-ok'],
      'dismiss',
      'bulk note',
      true,
    )) as Record<string, unknown>;

    // dedupe: 'r-ok' duplikat hanya diproses sekali.
    expect(res.total).toBe(2);
    expect(res.succeeded).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.results).toEqual([
      { id: 'r-ok', ok: true, status: 'DISMISSED' },
      { id: 'r-bad', ok: false, error: 'Sudah diselesaikan' },
    ]);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

describe('ADM-328 BulkReviewShowcaseReportsDto', () => {
  async function violations(input: Record<string, unknown>) {
    return validate(plainToInstance(BulkReviewShowcaseReportsDto, input));
  }

  it('menolak action takedown (hanya dismiss/under_review)', async () => {
    const v = await violations({ ids: ['r1'], action: 'takedown', confirm: true });
    expect(v.length).toBeGreaterThan(0);
    expect(v.some((x) => x.property === 'action')).toBe(true);
  });

  it('menolak ids > 50 dan ids kosong', async () => {
    const tooMany = await violations({
      ids: Array.from({ length: 51 }, (_, i) => `r${i}`),
      action: 'dismiss',
      confirm: true,
    });
    expect(tooMany.some((x) => x.property === 'ids')).toBe(true);
    const empty = await violations({ ids: [], action: 'dismiss', confirm: true });
    expect(empty.some((x) => x.property === 'ids')).toBe(true);
  });

  it('menerima payload valid dismiss/under_review', async () => {
    const v = await violations({ ids: ['r1', 'r2'], action: 'under_review', confirm: true });
    expect(v).toHaveLength(0);
  });
});
