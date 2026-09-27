import { BadRequestException, ConflictException } from '@nestjs/common';
import { ReconciliationFindingsService } from './reconciliation-findings.service';

/**
 * ADM-228 — temuan RESOLVED/ACCEPTED boleh dibuka kembali ke INVESTIGATING.
 * Membuktikan:
 *  1. RESOLVED → INVESTIGATING diizinkan bila ada catatan; audit memakai aksi
 *     spesifik RECONCILIATION_FINDING_REOPENED.
 *  2. ACCEPTED → INVESTIGATING diizinkan dengan catatan.
 *  3. Reopen TANPA catatan tetap 400 (fail-closed).
 *  4. Transisi ilegal lain (RESOLVED → RESOLVED) tetap 409.
 *  5. NEW → RESOLVED tanpa catatan tetap boleh (perilaku lama tidak berubah).
 */
describe('ReconciliationFindingsService.reopen (ADM-228)', () => {
  const prisma = {
    reconciliationFinding: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };
  const auditLog = { logAdminAction: jest.fn().mockResolvedValue(undefined) };
  const redis = { setex: jest.fn().mockResolvedValue(undefined) };

  const service = () =>
    new ReconciliationFindingsService(prisma as never, auditLog as never, redis as never);

  const row = (status: string) => ({
    id: 'finding-1',
    userId: 'user-1',
    recordedBalance: 10000000n,
    computedBalance: 9000000n,
    difference: 1000000n,
    violatedInvariants: ['LEDGER_MISMATCH'],
    status,
    batchId: 'batch-1',
    acknowledgedBy: 'admin-9',
    acknowledgedAt: new Date('2026-09-26T10:00:00Z'),
    notes: 'sudah dicek',
    createdAt: new Date('2026-09-26T10:00:00Z'),
    updatedAt: new Date('2026-09-26T10:00:00Z'),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.reconciliationFinding.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...row('INVESTIGATING'),
      ...data,
    }));
  });

  it.each(['RESOLVED', 'ACCEPTED'])(
    '%s → INVESTIGATING dengan catatan: diizinkan + audit REOPENED',
    async (from) => {
      prisma.reconciliationFinding.findUnique.mockResolvedValue(row(from));
      const res = (await service().acknowledgeFinding(
        'finding-1',
        'admin-1',
        { status: 'INVESTIGATING', notes: 'temuan muncul lagi di batch baru' } as never,
        '127.0.0.1',
      )) as { status: string };
      expect(res.status).toBe('INVESTIGATING');
      expect(prisma.reconciliationFinding.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'INVESTIGATING' }) }),
      );
      expect(auditLog.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'RECONCILIATION_FINDING_REOPENED',
          targetId: 'finding-1',
          before: { status: from },
          after: { status: 'INVESTIGATING' },
        }),
      );
    },
  );

  it('reopen tanpa catatan → 400, tanpa mutasi', async () => {
    prisma.reconciliationFinding.findUnique.mockResolvedValue(row('RESOLVED'));
    const err = await service()
      .acknowledgeFinding('finding-1', 'admin-1', { status: 'INVESTIGATING' } as never, '127.0.0.1')
      .catch(e => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.response.code).toBe('NOTES_REQUIRED');
    expect(prisma.reconciliationFinding.update).not.toHaveBeenCalled();
    expect(auditLog.logAdminAction).not.toHaveBeenCalled();
  });

  it('RESOLVED → RESOLVED tetap 409', async () => {
    prisma.reconciliationFinding.findUnique.mockResolvedValue(row('RESOLVED'));
    const err = await service()
      .acknowledgeFinding('finding-1', 'admin-1', { status: 'RESOLVED', notes: 'x' } as never, '127.0.0.1')
      .catch(e => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.response.code).toBe('INVALID_FINDING_TRANSITION');
    expect(auditLog.logAdminAction).not.toHaveBeenCalled();
  });

  it('NEW → RESOLVED tanpa catatan tetap boleh (audit ACKNOWLEDGED, bukan REOPENED)', async () => {
    prisma.reconciliationFinding.findUnique.mockResolvedValue(row('NEW'));
    prisma.reconciliationFinding.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...row('RESOLVED'),
      ...data,
    }));
    await service().acknowledgeFinding(
      'finding-1',
      'admin-1',
      { status: 'RESOLVED' } as never,
      '127.0.0.1',
    );
    expect(auditLog.logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'RECONCILIATION_FINDING_ACKNOWLEDGED' }),
    );
  });
});
