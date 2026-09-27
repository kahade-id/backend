/**
 * ADM-302 — RBAC takedown: CUSTOMER_SUPPORT tidak boleh takedown via API
 * langsung (guard hanya di UI = client-side saja → bypass).
 * ADM-320 — catatan resolusi wajib (min. 10 karakter) untuk takedown.
 *
 * Keduanya di-enforce di service `reviewShowcaseReport` (fail closed):
 * - action === 'takedown' + role !== SUPER_ADMIN → 403 TAKEDOWN_FORBIDDEN_ROLE
 * - action === 'takedown' + resolution < 10 karakter → 400 RESOLUTION_REQUIRED_TAKEDOWN
 * - SUPER_ADMIN + resolution valid → lolos guard takedown
 */
import 'reflect-metadata';
import { AdminRole } from '@prisma/client';
import { AdminShowcaseReportsService } from '../admin-showcase-reports.service';

const ADMIN_ID = 'super-admin-uuid';
const REPORT_ID = 'report-uuid-1';
const ITEM_ID = 'cshowcase000000000000001';

function codeOf(err: unknown): string | undefined {
  if (err && typeof (err as { getResponse?: unknown }).getResponse === 'function') {
    const res = (err as { getResponse: () => unknown }).getResponse();
    if (res && typeof res === 'object') return (res as { code?: string }).code;
  }
  return undefined;
}

function makeService() {
  const prisma: any = {
    showcaseReport: {
      findUnique: jest.fn().mockResolvedValue({
        id: REPORT_ID,
        status: 'PENDING',
        reason: 'SPAM',
        reporterId: 'reporter-1',
        showcaseId: ITEM_ID,
        showcase: { id: ITEM_ID, title: 'Item uji', isActive: true, userId: 'owner-1' },
      }),
    },
    userShowcase: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $transaction: jest.fn(async (ops: any[]) => {
      for (const op of ops) await op;
    }),
  };
  const auditLog = { logAdminAction: jest.fn(), logUserAction: jest.fn() };
  const service = new AdminShowcaseReportsService(prisma, auditLog as never, {} as never);
  (service as any).captureItemSnapshot = jest.fn().mockResolvedValue({});
  (service as any).recordEvent = jest.fn().mockResolvedValue(undefined);
  (service as any).logAction = jest.fn();
  (service as any).notifyReporterStatusChange = jest.fn();
  (service as any).notifyOwnerItemAction = jest.fn();
  return service;
}

async function expectCode(promise: Promise<unknown>, expectedCode: string) {
  try {
    await promise;
  } catch (err) {
    expect(codeOf(err)).toBe(expectedCode);
    return;
  }
  throw new Error(`seharusnya melempar ${expectedCode}`);
}

describe('ADM-302 — takedown hanya SUPER_ADMIN (server-side)', () => {
  it('CUSTOMER_SUPPORT takedown → 403 TAKEDOWN_FORBIDDEN_ROLE', async () => {
    await expectCode(
      makeService().reviewShowcaseReport(
        REPORT_ID, 'takedown', 'Catatan resolusi yang cukup panjang', ADMIN_ID, '127.0.0.1',
        AdminRole.CUSTOMER_SUPPORT,
      ),
      'TAKEDOWN_FORBIDDEN_ROLE',
    );
  });

  it('role undefined → 403 fail-closed', async () => {
    await expectCode(
      makeService().reviewShowcaseReport(
        REPORT_ID, 'takedown', 'Catatan resolusi yang cukup panjang', ADMIN_ID, '127.0.0.1',
        undefined,
      ),
      'TAKEDOWN_FORBIDDEN_ROLE',
    );
  });

  it('CUSTOMER_SUPPORT tetap bisa dismiss (aksi non-takedown tidak diblokir)', async () => {
    const service = makeService();
    (service as any).transition = jest.fn().mockResolvedValue(undefined);
    const res = await service.reviewShowcaseReport(
      REPORT_ID, 'dismiss', 'tidak melanggar', ADMIN_ID, '127.0.0.1',
      AdminRole.CUSTOMER_SUPPORT,
    );
    expect(res.status).toBe('DISMISSED');
  });
});

describe('ADM-320 — resolution wajib untuk takedown', () => {
  it('tanpa resolution → 400 RESOLUTION_REQUIRED_TAKEDOWN', async () => {
    await expectCode(
      makeService().reviewShowcaseReport(
        REPORT_ID, 'takedown', undefined, ADMIN_ID, '127.0.0.1', AdminRole.SUPER_ADMIN,
      ),
      'RESOLUTION_REQUIRED_TAKEDOWN',
    );
  });

  it('resolution 5 karakter → 400 RESOLUTION_REQUIRED_TAKEDOWN', async () => {
    await expectCode(
      makeService().reviewShowcaseReport(
        REPORT_ID, 'takedown', 'abcde', ADMIN_ID, '127.0.0.1', AdminRole.SUPER_ADMIN,
      ),
      'RESOLUTION_REQUIRED_TAKEDOWN',
    );
  });

  it('resolution ≥10 karakter → guard takedown lolos (gagal di langkah berikutnya, bukan di guard)', async () => {
    // findUnique mock selalu mengembalikan status PENDING → langkah reload
    // setelah transaksi melempar REPORT_ALREADY_RESOLVED. Yang dipastikan di
    // sini: guard RBAC + resolution TIDAK menolak permintaan valid.
    try {
      await makeService().reviewShowcaseReport(
        REPORT_ID, 'takedown', 'Spam terkonfirmasi dengan bukti kuat', ADMIN_ID, '127.0.0.1',
        AdminRole.SUPER_ADMIN,
      );
    } catch (err) {
      const code = codeOf(err);
      expect(code).not.toBe('TAKEDOWN_FORBIDDEN_ROLE');
      expect(code).not.toBe('RESOLUTION_REQUIRED_TAKEDOWN');
      return;
    }
    throw new Error('seharusnya melempar di langkah reload (mock)');
  });
});
