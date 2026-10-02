/**
 * SH-A-003 — POST /v1/admin/showcase-reports/items/:id/restore-takedown.
 * SH-S-005 — bukti banding = file key terverifikasi (bukan JSON bebas).
 *
 * Cakupan:
 * - SH-A-003: kontrak exact { ok: true, item } dengan bentuk item = GET detail
 *   existing; SUPER_ADMIN only (metadata @AdminRoles); audit-logged;
 *   isActive=true; event RESTORED tercatat.
 * - SH-A-003: item yang dinonaktifkan owner (tanpa event TAKEDOWN) → 400
 *   SHOWCASE_NOT_TAKEN_DOWN; item sudah aktif → 400; item tidak ada → 404.
 * - SH-S-005: fileAppeal memanggil verifyEvidenceFileKeys(userId, keys,
 *   'report-evidence'); DTO menolak newEvidence bebas & evidence kosong.
 */
import 'reflect-metadata';
import { AdminRole } from '@prisma/client';
import { AdminShowcaseReportsService } from '../admin-showcase-reports.service';
import { AdminShowcaseReportsController } from '../admin-showcase-reports.controller';
import { ADMIN_ROLES_KEY } from '../../../../common/decorators/admin-roles.decorator';
import * as ErrorCodes from '../../../../common/constants/error-codes';

const ADMIN_ID = 'super-admin-uuid';
const ITEM_ID = 'cshowcase000000000000001';
const REPORT_ID = 'report-uuid-1';
const OWNER_ID = 'owner-uuid-1';

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
    update: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    count: jest.fn().mockResolvedValue(0),
  };
}

function makePrismaMock() {
  const prisma: any = {
    userShowcase: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    showcaseReport: { findUnique: jest.fn() },
    adminUser: { findUnique: jest.fn().mockResolvedValue(null) },
    reportModerationEvent: delegateMock(),
    reportAppeal: delegateMock(),
  };
  // $transaction: jalankan callback dengan tx yang berbagi mock delegate,
  // sehingga update + create RESTORED teramati pada mock yang sama.
  prisma.$transaction = jest.fn(async (cb: any) => cb(prisma));
  return prisma;
}

function makeService(prisma: any, uploadService: any) {
  const auditLog = { logAdminAction: jest.fn(), logUserAction: jest.fn() };
  const service = new AdminShowcaseReportsService(prisma, auditLog as never, uploadService);
  return { service, auditLog };
}

const inactiveItem = () => ({
  id: ITEM_ID,
  title: 'Komisi ilustrasi',
  isActive: false,
  deletedAt: null,
  userId: OWNER_ID,
});

const restoredItemDetail = () => ({
  id: ITEM_ID,
  title: 'Komisi ilustrasi',
  description: 'desc',
  category: 'ilustrasi',
  isActive: true,
  visibility: 'PUBLIC',
  priceMin: 150000n,
  priceMax: 350000n,
  likeCount: 4,
  commentCount: 2,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  images: [{ id: 'img-1', imageUrl: 'https://cdn.test/a.jpg', sortOrder: 0 }],
  user: { id: OWNER_ID, username: 'seller', fullName: 'Seller', avatarUrl: null },
});

describe('SH-A-003 — restoreTakedownItem', () => {
  let prisma: any;
  let service: AdminShowcaseReportsService;
  let auditLog: any;
  const uploadService = { verifyEvidenceFileKeys: jest.fn().mockResolvedValue(undefined) };

  const events = () => prisma.reportModerationEvent;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = makePrismaMock();
    ({ service, auditLog } = makeService(prisma, uploadService));
  });

  it('restores a genuinely taken-down item: isActive=true, RESTORED event, audit log, exact response shape', async () => {
    prisma.userShowcase.findUnique
      .mockResolvedValueOnce(inactiveItem()) // pre-check
      .mockResolvedValueOnce(restoredItemDetail()); // final detail
    events().findFirst
      .mockResolvedValueOnce({ id: 'ev-takedown', reportId: REPORT_ID, createdAt: new Date('2026-09-20T00:00:00.000Z') })
      .mockResolvedValueOnce(null); // tidak ada RESTORED setelah takedown
    prisma.userShowcase.update.mockResolvedValue({ id: ITEM_ID, isActive: true });

    const result = (await service.restoreTakedownItem(ADMIN_ID, ITEM_ID, '1.2.3.4')) as any;

    // Atomic: update + event RESTORED dalam SATU $transaction.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // isActive di-set true.
    expect(prisma.userShowcase.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ITEM_ID }, data: { isActive: true } }),
    );
    // Event RESTORED tercatat pada laporan takedown.
    expect(events().create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reportId: REPORT_ID, actorAdminId: ADMIN_ID, action: 'RESTORED' }),
      }),
    );
    // Audit-logged.
    expect(auditLog.logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ adminId: ADMIN_ID, targetId: REPORT_ID }),
    );
    // Kontrak exact: { ok: true, item } — bentuk item = GET detail existing.
    expect(result.ok).toBe(true);
    expect(result.item.id).toBe(ITEM_ID);
    expect(result.item.isActive).toBe(true);
    expect(result.item).toHaveProperty('images');
    expect(result.item).toHaveProperty('user');
  });

  it('rejects a TAKEDOWN that was already restored (stale event cannot re-activate an owner-deactivated item)', async () => {
    prisma.userShowcase.findUnique.mockResolvedValue(inactiveItem());
    events().findFirst
      .mockResolvedValueOnce({ id: 'ev-takedown', reportId: REPORT_ID, createdAt: new Date('2026-09-20T00:00:00.000Z') })
      .mockResolvedValueOnce({ id: 'ev-restored', createdAt: new Date('2026-09-21T00:00:00.000Z') }); // RESTORED setelah takedown

    const err = await service.restoreTakedownItem(ADMIN_ID, ITEM_ID, '1.2.3.4').catch((e) => e);
    expect(codeOf(err)).toBe(ErrorCodes.SHOWCASE_NOT_TAKEN_DOWN);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.userShowcase.update).not.toHaveBeenCalled();
    expect(events().create).not.toHaveBeenCalled();
  });

  it('rolls back isActive when the RESTORED event write fails (atomic transaction)', async () => {
    prisma.userShowcase.findUnique
      .mockResolvedValueOnce(inactiveItem())
      .mockResolvedValueOnce(restoredItemDetail());
    events().findFirst
      .mockResolvedValueOnce({ id: 'ev-takedown', reportId: REPORT_ID, createdAt: new Date() })
      .mockResolvedValueOnce(null);
    events().create.mockRejectedValueOnce(new Error('db down'));
    prisma.$transaction.mockImplementationOnce(async (cb: any) => {
      // Simulasikan rollback: callback gagal → tidak ada update yang bertahan.
      await cb(prisma);
      throw new Error('db down');
    });

    const err = await service.restoreTakedownItem(ADMIN_ID, ITEM_ID, '1.2.3.4').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(auditLog.logAdminAction).not.toHaveBeenCalled();
  });

  it('rejects with SHOWCASE_NOT_TAKEN_DOWN when the item was deactivated by its owner (no TAKEDOWN event)', async () => {
    prisma.userShowcase.findUnique.mockResolvedValue(inactiveItem());
    events().findFirst.mockResolvedValue(null); // tidak ada event TAKEDOWN

    const err = await service.restoreTakedownItem(ADMIN_ID, ITEM_ID, '1.2.3.4').catch((e) => e);
    expect(codeOf(err)).toBe(ErrorCodes.SHOWCASE_NOT_TAKEN_DOWN);
    expect(prisma.userShowcase.update).not.toHaveBeenCalled();
    expect(events().create).not.toHaveBeenCalled();
  });

  it('rejects an already-active item (nothing to restore)', async () => {
    prisma.userShowcase.findUnique.mockResolvedValue({ ...inactiveItem(), isActive: true });
    const err = await service.restoreTakedownItem(ADMIN_ID, ITEM_ID, '1.2.3.4').catch((e) => e);
    expect(codeOf(err)).toBe(ErrorCodes.SHOWCASE_ALREADY_ACTIVE);
    expect(prisma.userShowcase.update).not.toHaveBeenCalled();
  });

  it('404 when the item does not exist', async () => {
    prisma.userShowcase.findUnique.mockResolvedValue(null);
    const err = await service.restoreTakedownItem(ADMIN_ID, ITEM_ID, '1.2.3.4').catch((e) => e);
    expect(codeOf(err)).toBe(ErrorCodes.SHOWCASE_NOT_FOUND);
  });

  it('controller route is SUPER_ADMIN-only via @AdminRoles metadata', () => {
    const roles: AdminRole[] | undefined = Reflect.getMetadata(
      ADMIN_ROLES_KEY,
      AdminShowcaseReportsController.prototype.restoreTakedown,
    );
    expect(roles).toEqual([AdminRole.SUPER_ADMIN]);
  });
});

describe('SH-S-005 — appeal evidence must be verified file keys', () => {
  // SYS-D-002 (2026-10-03): uji validasi FileShowcaseAppealDto dihapus bersama
  // DTO + endpoint banding user-facing yang mati. Validasi evidence tetap
  // ditegakkan di service (diuji di bawah).
  it('fileAppeal verifies evidence via verifyEvidenceFileKeys(report-evidence) and stores the key list', async () => {
    jest.clearAllMocks();
    const prisma = makePrismaMock();
    const uploadService = { verifyEvidenceFileKeys: jest.fn().mockResolvedValue(undefined) };
    const { service } = makeService(prisma, uploadService);

    const key = `uploads/report-evidence/${OWNER_ID}/1700000000-a.jpg`;
    prisma.userShowcase.findFirst.mockResolvedValue({ id: ITEM_ID, title: 'Komisi', isActive: false });
    prisma.reportModerationEvent.findFirst.mockResolvedValue({
      id: 'ev-takedown', reportId: REPORT_ID, action: 'TAKEDOWN', createdAt: new Date(),
    });
    prisma.showcaseReport.findUnique.mockResolvedValue({ id: REPORT_ID, status: 'RESOLVED_ACTION_TAKEN', showcaseId: ITEM_ID });
    prisma.reportAppeal.findFirst.mockResolvedValue(null);
    prisma.reportAppeal.create.mockImplementation(async (args: any) => ({ id: 'appeal-1', ...args.data }));

    const result = await service.fileAppeal(
      OWNER_ID,
      ITEM_ID,
      { reason: 'Alasan banding yang cukup panjang untuk lolos validasi minimal.', evidenceFileKeys: [key] },
      '1.2.3.4',
    );

    // Verifikasi kepemilikan + konfirmasi via UploadService dengan tipe report-evidence.
    expect(uploadService.verifyEvidenceFileKeys).toHaveBeenCalledWith(OWNER_ID, [key], 'report-evidence');
    // Yang tersimpan = daftar key terverifikasi, bukan JSON bebas.
    expect(prisma.reportAppeal.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ newEvidence: { fileKeys: [key] } }) }),
    );
    expect(result.appealId).toBe('appeal-1');
  });

  it('fileAppeal rejects when verifyEvidenceFileKeys throws (foreign/traversal key)', async () => {
    jest.clearAllMocks();
    const prisma = makePrismaMock();
    const uploadService = {
      verifyEvidenceFileKeys: jest.fn().mockRejectedValue(new Error('invalid evidence file')),
    };
    const { service } = makeService(prisma, uploadService);

    prisma.userShowcase.findFirst.mockResolvedValue({ id: ITEM_ID, title: 'Komisi', isActive: false });
    await expect(
      service.fileAppeal(
        OWNER_ID,
        ITEM_ID,
        { reason: 'Alasan banding yang cukup panjang untuk lolos validasi minimal.', evidenceFileKeys: ['uploads/kyc-ktp/victim/x.jpg'] },
        '1.2.3.4',
      ),
    ).rejects.toThrow('invalid evidence file');
    expect(prisma.reportAppeal.create).not.toHaveBeenCalled();
  });
});
