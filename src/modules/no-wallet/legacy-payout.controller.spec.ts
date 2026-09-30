import { LegacyPayoutController } from './legacy-payout.controller';
import { EscrowDisbursementScope } from '@prisma/client';

/**
 * Kontrak FE untuk status pencairan dana user (cashback, referral, escrow).
 *
 * GET /v1/legacy-payout/disbursements?scope=CASHBACK&limit=20
 * → { items: [{ id, scope, scopeRefId, orderId, amountSen, status,
 *               heldReason, lastError, danaReferenceNo, createdAt, updatedAt }] }
 *
 * scope valid: CASHBACK | REFERRAL | ORDER_ESCROW | MILESTONE | DISPUTE_RELEASE.
 * scope tak dikenal diabaikan (tidak difilter). limit di-clamp 1–100 (default 20).
 */
describe('LegacyPayoutController.getDisbursements', () => {
  function makeController() {
    const legacyPayout = { requestPayout: jest.fn() };
    const escrowDisbursement = { getDisbursementsForUser: jest.fn().mockResolvedValue([]) };
    const controller = new LegacyPayoutController(legacyPayout as any, escrowDisbursement as any);
    return { controller, escrowDisbursement };
  }

  it('meneruskan scope=CASHBACK ke service', async () => {
    const { controller, escrowDisbursement } = makeController();
    const out = await controller.getDisbursements('user-1', 'CASHBACK', '20');
    expect(out).toEqual({ items: [] });
    expect(escrowDisbursement.getDisbursementsForUser).toHaveBeenCalledWith('user-1', {
      scope: EscrowDisbursementScope.CASHBACK,
      limit: 20,
    });
  });

  it('meneruskan scope=REFERRAL ke service', async () => {
    const { controller, escrowDisbursement } = makeController();
    await controller.getDisbursements('user-1', 'REFERRAL', undefined);
    expect(escrowDisbursement.getDisbursementsForUser).toHaveBeenCalledWith('user-1', {
      scope: EscrowDisbursementScope.REFERRAL,
      limit: 20,
    });
  });

  it('scope tak dikenal → tidak difilter (undefined)', async () => {
    const { controller, escrowDisbursement } = makeController();
    await controller.getDisbursements('user-1', 'BOGUS', undefined);
    expect(escrowDisbursement.getDisbursementsForUser).toHaveBeenCalledWith('user-1', {
      scope: undefined,
      limit: 20,
    });
  });

  it('limit di-clamp 1–100', async () => {
    const { controller, escrowDisbursement } = makeController();
    await controller.getDisbursements('user-1', undefined, '9999');
    expect(escrowDisbursement.getDisbursementsForUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ limit: 100 }),
    );
    await controller.getDisbursements('user-1', undefined, '-5');
    expect(escrowDisbursement.getDisbursementsForUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ limit: 1 }),
    );
  });

  it('respons = { items } — bentuk kontrak untuk FE', async () => {
    const { controller, escrowDisbursement } = makeController();
    const row = {
      id: 'd1',
      scope: EscrowDisbursementScope.CASHBACK,
      scopeRefId: 'cb-1',
      orderId: null,
      amountSen: '25000',
      status: 'SUCCESS',
      heldReason: null,
      lastError: null,
      danaReferenceNo: 'DANA-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    escrowDisbursement.getDisbursementsForUser.mockResolvedValue([row]);
    const out = await controller.getDisbursements('user-1', 'CASHBACK', undefined);
    expect(out).toEqual({ items: [row] });
  });
});
