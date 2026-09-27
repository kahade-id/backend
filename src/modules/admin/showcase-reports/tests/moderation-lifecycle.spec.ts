/**
 * G425 — spec lifecycle moderasi pasca-final laporan etalase (GAP-F).
 *
 * Cakupan:
 * - G401: reopen hanya dari status final + alasan manual wajib + role guard
 *   SUPER_ADMIN di controller (via metadata @AdminRoles).
 * - G402: append note tidak menyentuh resolution/status laporan.
 * - G404–G407: appeal — reviewer wajib ≠ moderator awal; konflik kepentingan
 *   90 hari ditolak (422).
 * - G408: APPROVED → item di-restore + event RESTORED; REJECTED → tidak.
 * - G403/G420: event append-only — service tidak pernah update/delete event.
 * - G424/G425: race condition dua admin → updateMany count 0 → REPORT_ALREADY_RESOLVED.
 * - G419: eskalasi SLA terlewati.
 * - G423: auto-restore RESTRICT_TEMPORARY yang kedaluwarsa.
 */
import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ReportStatus, AdminRole } from '@prisma/client';
import { AdminShowcaseReportsService } from '../admin-showcase-reports.service';
import { AdminShowcaseReportsController } from '../admin-showcase-reports.controller';
import { ADMIN_ROLES_KEY } from '../../../../common/decorators/admin-roles.decorator';
import * as ErrorCodes from '../../../../common/constants/error-codes';

const ADMIN_AWAL = 'admin-awal-uuid';
const ADMIN_REVIEWER = 'admin-reviewer-uuid';
const REPORT_ID = 'report-uuid-1';
const SHOWCASE_ID = 'showcase-uuid-1';

function codeOf(err: unknown): string | undefined {
  if (err && typeof (err as { getResponse?: unknown }).getResponse === 'function') {
    const res = (err as { getResponse: () => unknown }).getResponse();
    if (res && typeof res === 'object') return (res as { code?: string }).code;
  }
  return undefined;
}

function delegateMock() {
  return {
    create: jest.fn().mockResolvedValue({ id: 'ev-1' }),
    createMany: jest.fn().mockResolvedValue({ count: 1 }),
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
    findUnique: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockImplementation((args: { where: { id: string } }) =>
      Promise.resolve({ id: args.where.id }),
    ),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    count: jest.fn().mockResolvedValue(0),
  };
}

function makePrismaMock() {
  const prisma: Record<string, unknown> = {
    showcaseReport: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    userShowcase: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    notification: { create: jest.fn().mockResolvedValue({ id: 'n1' }) },
    adminUser: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    user: { findUnique: jest.fn() },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    emitNotificationCreated: jest.fn(),
    reportModerationEvent: delegateMock(),
    reportAppeal: delegateMock(),
    reportCluster: delegateMock(),
    reportClusterMember: delegateMock(),
    reportAssignment: delegateMock(),
  };
  return prisma;
}

function makeService(prisma: Record<string, unknown>) {
  const auditLog = {
    logAdminAction: jest.fn(),
    logUserAction: jest.fn(),
  };
  const service = new AdminShowcaseReportsService(
    prisma as never,
    auditLog as never,
  );
  return { service, auditLog };
}

function baseReport(overrides: Record<string, unknown> = {}) {
  return {
    id: REPORT_ID,
    showcaseId: SHOWCASE_ID,
    reporterId: 'reporter-uuid',
    reason: 'SPAM',
    description: 'spam massal',
    status: ReportStatus.DISMISSED,
    resolution: 'resolusi awal',
    reviewedBy: ADMIN_AWAL,
    reviewedAt: new Date('2026-09-20T00:00:00.000Z'),
    createdAt: new Date('2026-09-19T00:00:00.000Z'),
    ...overrides,
  };
}

describe('AdminShowcaseReportsService — moderation lifecycle (G425)', () => {
  let prisma: Record<string, unknown>;
  let service: AdminShowcaseReportsService;

  beforeEach(() => {
    prisma = makePrismaMock();
    ({ service } = makeService(prisma));
    jest.clearAllMocks();
  });

  const events = () => prisma.reportModerationEvent as ReturnType<typeof delegateMock>;

  // -------------------------------------------------------------------------
  // G401 — reopen.
  // -------------------------------------------------------------------------
  describe('G401 reopenReport', () => {
    it('404 bila laporan tidak ada', async () => {
      (prisma.showcaseReport as { findUnique: jest.Mock }).findUnique.mockResolvedValue(null);
      await expect(
        service.reopenReport(REPORT_ID, 'alasan yang cukup panjang', undefined, ADMIN_AWAL, '1.2.3.4'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('menolak reopen dari status NON-final (PENDING)', async () => {
      (prisma.showcaseReport as { findUnique: jest.Mock }).findUnique.mockResolvedValue(
        baseReport({ status: ReportStatus.PENDING }),
      );
      const err = await service
        .reopenReport(REPORT_ID, 'alasan yang cukup panjang', undefined, ADMIN_AWAL, '1.2.3.4')
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(codeOf(err)).toBe(ErrorCodes.REPORT_NOT_FINAL);
    });

    it('menolak reopen bila alasan < 10 karakter (G422)', async () => {
      (prisma.showcaseReport as { findUnique: jest.Mock }).findUnique.mockResolvedValue(
        baseReport({ status: ReportStatus.DISMISSED }),
      );
      const err = await service
        .reopenReport(REPORT_ID, 'pendek', undefined, ADMIN_AWAL, '1.2.3.4')
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(codeOf(err)).toBe(ErrorCodes.REPORT_REOPEN_REASON_REQUIRED);
    });

    it('berhasil: DISMISSED → UNDER_REVIEW + event REOPENED (append-only)', async () => {
      (prisma.showcaseReport as { findUnique: jest.Mock }).findUnique.mockResolvedValue(
        baseReport({ status: ReportStatus.DISMISSED }),
      );
      (prisma.userShowcase as { findUnique: jest.Mock }).findUnique.mockResolvedValue({
        title: 'Item A',
      });
      (prisma.showcaseReport as { updateMany: jest.Mock }).updateMany.mockResolvedValue({ count: 1 });

      const res = await service.reopenReport(
        REPORT_ID,
        'Ditemukan bukti baru dari pelapor kedua',
        undefined,
        ADMIN_AWAL,
        '1.2.3.4',
      );
      expect(res.status).toBe(ReportStatus.UNDER_REVIEW);
      const create = events().create;
      expect(create).toHaveBeenCalledTimes(1);
      const payload = create.mock.calls[0][0].data as Record<string, unknown>;
      expect(payload.action).toBe('REOPENED');
      expect(payload.stateFrom).toBe(ReportStatus.DISMISSED);
      expect(payload.stateTo).toBe(ReportStatus.UNDER_REVIEW);
      // Event append-only: tidak ada update/delete event.
      expect(events().update).not.toHaveBeenCalled();
    });

    it('controller: endpoint reopen hanya untuk SUPER_ADMIN (403 untuk CUSTOMER_SUPPORT)', () => {
      const roles = Reflect.getMetadata(
        ADMIN_ROLES_KEY,
        AdminShowcaseReportsController.prototype.reopenShowcaseReport,
      ) as AdminRole[];
      expect(roles).toEqual([AdminRole.SUPER_ADMIN]);
    });
  });

  // -------------------------------------------------------------------------
  // G424/G425 — race condition via OCC updateMany.
  // -------------------------------------------------------------------------
  describe('G424/G425 transition race', () => {
    it('dua admin review bersamaan → yang kalah dapat REPORT_ALREADY_RESOLVED', async () => {
      (prisma.showcaseReport as { updateMany: jest.Mock }).updateMany.mockResolvedValue({ count: 0 });
      const err = await service
        .transition(REPORT_ID, ReportStatus.PENDING, ReportStatus.UNDER_REVIEW, {
          adminId: ADMIN_REVIEWER,
          ipAddress: '1.2.3.4',
          eventAction: 'UNDER_REVIEW',
        })
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(codeOf(err)).toBe(ErrorCodes.REPORT_ALREADY_RESOLVED);
      // Tidak ada event yang ditulis untuk transisi yang gagal.
      expect(events().create).not.toHaveBeenCalled();
    });

    it('transisi ilegal ditolak sebelum menyentuh DB', async () => {
      const err = await service
        .transition(REPORT_ID, ReportStatus.DISMISSED, ReportStatus.RESOLVED_NO_ACTION, {
          adminId: ADMIN_REVIEWER,
          ipAddress: '1.2.3.4',
          eventAction: 'DISMISSED',
        })
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(codeOf(err)).toBe(ErrorCodes.REPORT_INVALID_TRANSITION);
      expect(prisma.showcaseReport as object).toBeDefined();
      expect((prisma.showcaseReport as { updateMany: jest.Mock }).updateMany).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // G402 — append note.
  // -------------------------------------------------------------------------
  describe('G402 addModerationNote', () => {
    it('catatan kosong ditolak', async () => {
      (prisma.showcaseReport as { findUnique: jest.Mock }).findUnique.mockResolvedValue(
        baseReport(),
      );
      const err = await service
        .addModerationNote(REPORT_ID, '   ', ADMIN_AWAL, '1.2.3.4')
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(codeOf(err)).toBe(ErrorCodes.MODERATION_NOTE_TOO_SHORT);
    });

    it('catatan ditulis sebagai event NOTE_ADDED; resolution/status tidak disentuh', async () => {
      (prisma.showcaseReport as { findUnique: jest.Mock }).findUnique.mockResolvedValue(
        baseReport({ resolution: 'resolusi awal — jangan ditimpa' }),
      );
      const res = await service.addModerationNote(REPORT_ID, 'catatan tindak lanjut', ADMIN_AWAL, '1.2.3.4');
      expect(res.reportId).toBe(REPORT_ID);
      const payload = events().create.mock.calls[0][0].data as Record<string, unknown>;
      expect(payload.action).toBe('NOTE_ADDED');
      expect(payload.note).toBe('catatan tindak lanjut');
      expect((prisma.showcaseReport as { updateMany: jest.Mock }).updateMany).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // G404–G408 — appeal.
  // -------------------------------------------------------------------------
  describe('decideAppeal (G404–G408)', () => {
    const appealRow = {
      id: 'appeal-uuid-1',
      reportId: REPORT_ID,
      appellantType: 'OWNER',
      appellantUserId: 'owner-uuid',
      reason: 'alasan banding yang cukup panjang untuk validasi',
      newEvidence: { files: ['bukti.png'] },
      status: 'PENDING',
      reviewerAdminId: null,
      decidedAt: null,
      decisionNote: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    function mockDecideSetup(conflictEvent: object | null) {
      (prisma.reportAppeal as { findUnique: jest.Mock }).findUnique.mockResolvedValue(appealRow);
      (prisma.showcaseReport as { findUnique: jest.Mock }).findUnique.mockResolvedValue({
        ...baseReport(),
        showcase: { id: SHOWCASE_ID, title: 'Item A', isActive: false, userId: 'owner-uuid' },
      });
      (prisma.showcaseReport as { findMany: jest.Mock }).findMany.mockResolvedValue([{ id: REPORT_ID }]);
      (prisma.reportModerationEvent as { findFirst: jest.Mock }).findFirst.mockResolvedValue(conflictEvent);
      (prisma.reportAppeal as { update: jest.Mock }).update.mockImplementation(
        (args: { where: { id: string } }) => Promise.resolve({ ...appealRow, id: args.where.id }),
      );
    }

    it('G406: reviewer sama dengan moderator awal → 422', async () => {
      mockDecideSetup(null);
      const err = await service
        .decideAppeal('appeal-uuid-1', 'APPROVED', 'catatan putusan cukup panjang', ADMIN_AWAL, '1.2.3.4')
        .catch((e) => e);
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      expect(codeOf(err)).toBe(ErrorCodes.APPEAL_REVIEWER_CONFLICT);
    });

    it('G407: reviewer dengan konflik kepentingan 90 hari → 422', async () => {
      mockDecideSetup({ id: 'ev-konflik' });
      const err = await service
        .decideAppeal('appeal-uuid-1', 'APPROVED', 'catatan putusan cukup panjang', ADMIN_REVIEWER, '1.2.3.4')
        .catch((e) => e);
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      expect(codeOf(err)).toBe(ErrorCodes.APPEAL_REVIEWER_CONFLICT);
    });

    it('G408: APPROVED → item di-restore + event RESTORED', async () => {
      mockDecideSetup(null);
      (prisma.userShowcase as { updateMany: jest.Mock }).updateMany.mockResolvedValue({ count: 1 });
      const res = (await service.decideAppeal(
        'appeal-uuid-1',
        'APPROVED',
        'bukti baru valid, item dikembalikan',
        ADMIN_REVIEWER,
        '1.2.3.4',
      )) as { restored: boolean };
      expect(res.restored).toBe(true);
      expect((prisma.userShowcase as { updateMany: jest.Mock }).updateMany).toHaveBeenCalledWith({
        where: { id: SHOWCASE_ID, isActive: false },
        data: { isActive: true },
      });
      const actions = events().create.mock.calls.map(
        (c) => (c[0].data as Record<string, unknown>).action,
      );
      expect(actions).toContain('APPEAL_DECIDED');
      expect(actions).toContain('RESTORED');
    });

    it('REJECTED → item TIDAK di-restore', async () => {
      mockDecideSetup(null);
      const res = (await service.decideAppeal(
        'appeal-uuid-1',
        'REJECTED',
        'bukti tidak cukup kuat untuk membatalkan',
        ADMIN_REVIEWER,
        '1.2.3.4',
      )) as { restored: boolean };
      expect(res.restored).toBe(false);
      expect((prisma.userShowcase as { updateMany: jest.Mock }).updateMany).not.toHaveBeenCalled();
      const actions = events().create.mock.calls.map(
        (c) => (c[0].data as Record<string, unknown>).action,
      );
      expect(actions).toContain('APPEAL_DECIDED');
      expect(actions).not.toContain('RESTORED');
    });

    it('banding yang sudah diputus tidak bisa diputus ulang (409)', async () => {
      (prisma.reportAppeal as { findUnique: jest.Mock }).findUnique.mockResolvedValue({
        ...appealRow,
        status: 'APPROVED',
      });
      const err = await service
        .decideAppeal('appeal-uuid-1', 'REJECTED', 'catatan putusan cukup panjang', ADMIN_REVIEWER, '1.2.3.4')
        .catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(codeOf(err)).toBe(ErrorCodes.APPEAL_ALREADY_DECIDED);
    });
  });

  // -------------------------------------------------------------------------
  // G419 — eskalasi overdue.
  // -------------------------------------------------------------------------
  describe('G419 escalateOverdueAssignments', () => {
    it('assignment melewati SLA → escalated + event ESCALATED', async () => {
      const past = new Date(Date.now() - 3_600_000);
      (prisma.reportAssignment as { findMany: jest.Mock }).findMany.mockResolvedValue([
        {
          id: 'assign-1',
          reportId: REPORT_ID,
          assigneeAdminId: ADMIN_AWAL,
          riskScore: 85,
          slaDueAt: past,
          escalated: false,
          assignedAt: new Date(Date.now() - 25 * 3_600_000),
          unassignedAt: null,
          createdAt: new Date(Date.now() - 25 * 3_600_000),
        },
      ]);
      const res = await service.escalateOverdueAssignments();
      expect(res.escalated).toBe(1);
      expect((prisma.reportAssignment as { update: jest.Mock }).update).toHaveBeenCalledWith({
        where: { id: 'assign-1' },
        data: { escalated: true },
      });
      const payload = events().create.mock.calls[0][0].data as Record<string, unknown>;
      expect(payload.action).toBe('ESCALATED');
      expect(payload.actorAdminId).toBeNull();
    });

    it('tidak ada yang overdue → no-op', async () => {
      const res = await service.escalateOverdueAssignments();
      expect(res.escalated).toBe(0);
      expect((prisma.reportAssignment as { update: jest.Mock }).update).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // G423 — auto-restore.
  // -------------------------------------------------------------------------
  describe('G423 autoRestoreExpiredRestrictions', () => {
    it('restrict kedaluwarsa + belum direstore → item aktif kembali + event RESTORED', async () => {
      const restrictAt = new Date(Date.now() - 8 * 24 * 3_600_000);
      (prisma.reportModerationEvent as { findMany: jest.Mock }).findMany.mockResolvedValue([
        {
          id: 'ev-restrict',
          reportId: REPORT_ID,
          action: 'RESTRICTED',
          createdAt: restrictAt,
          metadata: { restrictUntil: new Date(Date.now() - 24 * 3_600_000).toISOString() },
        },
      ]);
      (prisma.reportModerationEvent as { findFirst: jest.Mock }).findFirst.mockResolvedValue(null);
      (prisma.showcaseReport as { findUnique: jest.Mock }).findUnique.mockResolvedValue({
        showcaseId: SHOWCASE_ID,
      });
      (prisma.userShowcase as { findUnique: jest.Mock }).findUnique.mockResolvedValue({
        id: SHOWCASE_ID,
        title: 'Item A',
        userId: 'owner-uuid',
        isActive: false,
      });

      const res = await service.autoRestoreExpiredRestrictions();
      expect(res.restored).toBe(1);
      expect((prisma.userShowcase as { updateMany: jest.Mock }).updateMany).toHaveBeenCalledWith({
        where: { id: SHOWCASE_ID, isActive: false },
        data: { isActive: true },
      });
      const payload = events().create.mock.calls[0][0].data as Record<string, unknown>;
      expect(payload.action).toBe('RESTORED');
      expect((payload.metadata as Record<string, unknown>).viaScheduler).toBe(true);
    });

    it('restrict yang belum kedaluwarsa tidak direstore', async () => {
      (prisma.reportModerationEvent as { findMany: jest.Mock }).findMany.mockResolvedValue([
        {
          id: 'ev-restrict',
          reportId: REPORT_ID,
          action: 'RESTRICTED',
          createdAt: new Date(Date.now() - 24 * 3_600_000),
          metadata: { restrictUntil: new Date(Date.now() + 24 * 3_600_000).toISOString() },
        },
      ]);
      const res = await service.autoRestoreExpiredRestrictions();
      expect(res.restored).toBe(0);
      expect((prisma.userShowcase as { updateMany: jest.Mock }).updateMany).not.toHaveBeenCalled();
    });

    it('sudah ada RESTORED (mis. banding APPROVED) → scheduler tidak restore ulang', async () => {
      const restrictAt = new Date(Date.now() - 8 * 24 * 3_600_000);
      (prisma.reportModerationEvent as { findMany: jest.Mock }).findMany.mockResolvedValue([
        {
          id: 'ev-restrict',
          reportId: REPORT_ID,
          action: 'RESTRICTED',
          createdAt: restrictAt,
          metadata: { restrictUntil: new Date(Date.now() - 24 * 3_600_000).toISOString() },
        },
      ]);
      (prisma.reportModerationEvent as { findFirst: jest.Mock }).findFirst.mockResolvedValue({ id: 'ev-restored' });
      const res = await service.autoRestoreExpiredRestrictions();
      expect(res.restored).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // G403 — event append-only: tidak ada jalur update/delete event.
  // -------------------------------------------------------------------------
  describe('G403 append-only audit', () => {
    it('review dismiss menulis event DISMISSED; delegate event tidak punya pemanggil update/delete', async () => {
      const report = {
        ...baseReport({ status: ReportStatus.PENDING, reviewedBy: null }),
        showcase: { id: SHOWCASE_ID, title: 'Item A', isActive: true, userId: 'owner-uuid' },
      };
      (prisma.showcaseReport as { findUnique: jest.Mock }).findUnique.mockResolvedValue(report);
      (prisma.userShowcase as { findUnique: jest.Mock }).findUnique.mockResolvedValue({
        id: SHOWCASE_ID,
        title: 'Item A',
        isActive: true,
        visibility: 'PUBLIC',
        category: 'x',
        priceMin: null,
        priceMax: null,
        userId: 'owner-uuid',
        user: { id: 'owner-uuid', username: 'toko' },
        images: [],
      });
      (prisma.showcaseReport as { updateMany: jest.Mock }).updateMany.mockResolvedValue({ count: 1 });

      await service.reviewShowcaseReport(REPORT_ID, 'dismiss', 'alasan dismiss valid', ADMIN_AWAL, '1.2.3.4');
      const payload = events().create.mock.calls[0][0].data as Record<string, unknown>;
      expect(payload.action).toBe('DISMISSED');
      expect(payload.metadata).toHaveProperty('snapshot');
      expect(events().update).not.toHaveBeenCalled();
    });
  });
});
