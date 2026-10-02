import { ForbiddenException } from '@nestjs/common';
import { ApprovalsService } from '../approvals.service';
import * as ErrorCodes from '../../../../common/constants/error-codes';

/**
 * Dual control: pengusul TIDAK BOLEH menyetujui usulannya sendiri
 * (maker-checker, SEC-501/502).
 */
describe('ApprovalsService self-approval guard', () => {
  type Rec = {
    id: string;
    actionType: string;
    targetId: string | null;
    payload: Record<string, unknown>;
    amountSen: bigint;
    proposedBy: string;
    proposedAt: Date;
    status: string;
    decidedBy: string | null;
    decidedAt: Date | null;
    executedAt: Date | null;
    expiresAt: Date;
    rejectReason: string | null;
  };
  const store = new Map<string, Rec>();

  const prisma = {
    adminActionApproval: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => store.get(where.id) ?? null),
      updateMany: jest.fn(
        async ({ where, data }: { where: { id: string; status?: string }; data: Partial<Rec> }) => {
          const rec = store.get(where.id);
          if (!rec) return { count: 0 };
          if (where.status && rec.status !== where.status) return { count: 0 };
          Object.assign(rec, data);
          return { count: 1 };
        },
      ),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Rec> }) => {
        const rec = store.get(where.id);
        if (!rec) throw new Error('not found');
        Object.assign(rec, data);
        return rec;
      }),
    },
  };
  const auditLog = { logAdminAction: jest.fn() };
  const service = new ApprovalsService(prisma as never, auditLog as never);
  const executor = jest.fn(async () => ({ ok: true }));

  const PROPOSER = 'admin-proposer';
  const CHECKER = 'admin-checker';

  beforeEach(() => {
    store.clear();
    jest.clearAllMocks();
    service.registerExecutor('WALLET_ADJUST', executor);
    store.set('appr-1', {
      id: 'appr-1',
      actionType: 'WALLET_ADJUST',
      targetId: 'user-123',
      payload: { type: 'CREDIT', amount: 2000000, reason: 'koreksi saldo' },
      amountSen: 200000000n,
      proposedBy: PROPOSER,
      proposedAt: new Date(),
      status: 'PENDING',
      decidedBy: null,
      decidedAt: null,
      executedAt: null,
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      rejectReason: null,
    });
  });

  function codeOf(err: unknown): unknown {
    return ((err as ForbiddenException).getResponse() as { code?: unknown }).code;
  }

  it('pengusul menyetujui sendiri → 403 SELF_APPROVAL, executor TIDAK jalan', async () => {
    try {
      await service.approve('appr-1', PROPOSER, 'SUPER_ADMIN', '127.0.0.1');
      fail('seharusnya melempar');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(codeOf(err)).toBe(ErrorCodes.SELF_APPROVAL);
    }
    expect(executor).not.toHaveBeenCalled();
    expect(store.get('appr-1')!.status).toBe('PENDING');
  });

  it('admin kedua (role berhak) → EXECUTED dan executor jalan sekali', async () => {
    const res = await service.approve('appr-1', CHECKER, 'SUPER_ADMIN', '127.0.0.1');
    expect(res.status).toBe('EXECUTED');
    expect(executor).toHaveBeenCalledTimes(1);
    expect((executor.mock.calls[0] as unknown[])[0]).toMatchObject({
      approvalId: 'appr-1',
      proposedBy: PROPOSER,
      decidedBy: CHECKER,
    });
  });

  it('role tak berhak menyetujui → 403 APPROVAL_FORBIDDEN_ACTION', async () => {
    try {
      await service.approve('appr-1', CHECKER, 'CUSTOMER_SUPPORT', '127.0.0.1');
      fail('seharusnya melempar');
    } catch (err) {
      expect(codeOf(err)).toBe(ErrorCodes.APPROVAL_FORBIDDEN_ACTION);
    }
    expect(executor).not.toHaveBeenCalled();
  });
});
