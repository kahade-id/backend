// M5: milestone di mode tanpa-wallet — aktivasi dari payment DANA, release
// via disbursement DANA (scope MILESTONE), cancel sisa tahap via refund
// parsial DANA. TIDAK menyentuh wallet.
//
// Fake PrismaService minimal: hanya tabel/metode yang dipakai jalur
// no-wallet, dengan semantik updateMany bersyarat seperti Prisma asli.
import {
  activateMilestonesForOrderNoWalletTx,
} from '../milestone-activation';
import { MilestonesService } from '../milestones.service';
import {
  MilestoneActorType,
  MilestoneEventType,
  MilestoneStatus,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from '@prisma/client';

interface Row { [k: string]: any }

function makeFakePrisma() {
  const db: Record<string, Row[]> = {
    order: [],
    orderMilestone: [],
    milestoneEvent: [],
    escrowDisbursement: [],
    paymentTransaction: [],
    notification: [],
    orderStatusHistory: [],
  };

  const matchWhere = (row: Row, where: any): boolean => {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
      if (v === null) { if (row[k] !== null && row[k] !== undefined) return false; continue; }
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        const o = v as any;
        if ('equals' in o) { if (row[k] !== o.equals) return false; continue; }
        if ('in' in o) { if (!o.in.includes(row[k])) return false; continue; }
        continue;
      }
      if (row[k] !== v) return false;
    }
    return true;
  };

  const table = (name: string) => ({
    findMany: async (args: any) => {
      let rows = db[name].filter((r) => matchWhere(r, args?.where)).map((r) => ({ ...r }));
      if (name === 'orderMilestone' && args?.include?.order) {
        rows = rows.map((r) => ({ ...r, order: db.order.find((o) => o.id === r.orderId) }));
      }
      return rows;
    },
    findFirst: async (args: any) => {
      const r = db[name].find((x) => matchWhere(x, args?.where));
      return r ? { ...r } : null;
    },
    findUnique: async (args: any) => {
      const r = db[name].find((x) => matchWhere(x, args?.where));
      if (!r) return null;
      const out = { ...r };
      if (name === 'order' && args?.select) {
        const sel: Row = {};
        for (const k of Object.keys(args.select)) sel[k] = (out as Row)[k];
        return sel;
      }
      if (name === 'orderMilestone' && args?.include?.order) {
        out.order = db.order.find((o) => o.id === r.orderId);
      }
      return out;
    },
    findUniqueOrThrow: async (args: any) => {
      const r = await (table(name) as any).findUnique(args);
      if (!r) throw new Error(`${name} not found`);
      return r;
    },
    create: async (args: any) => {
      const r = { id: `${name}-${db[name].length + 1}`, ...args.data };
      db[name].push(r);
      return { ...r };
    },
    updateMany: async (args: any) => {
      let count = 0;
      for (const r of db[name]) {
        if (!matchWhere(r, args.where)) continue;
        Object.assign(r, args.data);
        count++;
      }
      return { count };
    },
    count: async (args: any) => db[name].filter((r) => matchWhere(r, args?.where)).length,
    groupBy: async (args: any) => {
      const groups = new Map<string, number>();
      for (const r of db[name]) {
        if (!matchWhere(r, args.where)) continue;
        const k = String(r[args.by[0]]);
        groups.set(k, (groups.get(k) ?? 0) + 1);
      }
      return [...groups.entries()].map(([status, c]) => ({ status, _count: { _all: c } }));
    },
  });

  const prisma: any = {
    order: table('order'),
    orderMilestone: table('orderMilestone'),
    milestoneEvent: table('milestoneEvent'),
    escrowDisbursement: table('escrowDisbursement'),
    paymentTransaction: table('paymentTransaction'),
    notification: table('notification'),
    orderStatusHistory: table('orderStatusHistory'),
    $transaction: async (fn: any) => fn(prisma),
  };
  return { prisma, db };
}

const sen = (idr: number) => BigInt(idr * 100);

function seedOrder(db: Record<string, Row[]>, overrides: Partial<Row> = {}) {
  const order = {
    id: 'ord-1', orderId: 'ORD-1', buyerId: 'buyer-1', sellerId: 'seller-1',
    status: 'PROCESSING', buyerPayAmount: sen(100000),
    ...overrides,
  };
  db.order.push(order);
  return order;
}

function seedMilestone(db: Record<string, Row[]>, overrides: Partial<Row> = {}) {
  const m = {
    id: `ms-${db.orderMilestone.length + 1}`, orderId: 'ord-1', seq: db.orderMilestone.length + 1,
    title: 'Tahap', status: MilestoneStatus.DRAFT,
    buyerAmount: sen(50000), sellerAmount: sen(47500),
    escrowHeld: 0n, releasedTxId: null,
    ...overrides,
  };
  db.orderMilestone.push(m);
  return m;
}

function makeSvc(deps: { walletEnabled: boolean; disbursement?: any; danaRefund?: any }) {
  const { prisma, db } = makeFakePrisma();
  const walletMode = { isWalletEnabled: () => deps.walletEnabled };
  const svc = new MilestonesService(
    prisma,
    {} as any,
    walletMode as any,
    (deps.disbursement ?? null) as any,
    (deps.danaRefund ?? null) as any,
  );
  return { svc, prisma, db };
}

// ---------------------------------------------------------------- aktivasi

describe('M5 aktivasi milestone no-wallet', () => {
  it('mengaktifkan DRAFT dari payment DANA SUCCESS tanpa menyentuh wallet', async () => {
    const { prisma, db } = makeFakePrisma();
    seedOrder(db);
    seedMilestone(db, { buyerAmount: sen(60000) });
    seedMilestone(db, { buyerAmount: sen(40000) });

    const res = await activateMilestonesForOrderNoWalletTx(prisma, 'ord-1', {
      paymentId: 'pay-1',
      amountSen: sen(100000),
    });
    expect(res.activated).toBe(2);
    for (const m of db.orderMilestone) {
      expect(m.status).toBe(MilestoneStatus.AWAITING_ACTIVATION);
      expect(m.escrowHeld).toBe(m.buyerAmount); // accounting marker
    }
    expect(db.milestoneEvent).toHaveLength(2);
    expect(db.milestoneEvent[0].eventType).toBe(MilestoneEventType.ACTIVATED);
    expect(db.milestoneEvent[0].payload.noWallet).toBe(true);
    expect(db.milestoneEvent[0].payload.danaPaymentId).toBe('pay-1');
    // Tidak ada tabel wallet di fake — aktivasi tidak membaca wallet sama sekali.
    expect((db as any).wallet).toBeUndefined();
  });

  it('fail-closed bila sum(buyerAmount) != buyerPayAmount', async () => {
    const { prisma, db } = makeFakePrisma();
    seedOrder(db, { buyerPayAmount: sen(99999) });
    seedMilestone(db, { buyerAmount: sen(60000) });
    seedMilestone(db, { buyerAmount: sen(40000) });
    await expect(
      activateMilestonesForOrderNoWalletTx(prisma, 'ord-1', { paymentId: 'pay-1', amountSen: sen(99999) }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'MILESTONE_INVARIANT_VIOLATION' }) });
    expect(db.orderMilestone.every((m) => m.status === MilestoneStatus.DRAFT)).toBe(true);
  });

  it('fail-closed bila nominal payment DANA != buyerPayAmount', async () => {
    const { prisma, db } = makeFakePrisma();
    seedOrder(db);
    seedMilestone(db, { buyerAmount: sen(100000) });
    await expect(
      activateMilestonesForOrderNoWalletTx(prisma, 'ord-1', { paymentId: 'pay-1', amountSen: sen(50000) }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'MILESTONE_INVARIANT_VIOLATION' }) });
  });

  it('no-op bila tidak ada DRAFT', async () => {
    const { prisma, db } = makeFakePrisma();
    seedOrder(db);
    const res = await activateMilestonesForOrderNoWalletTx(prisma, 'ord-1', {
      paymentId: 'pay-1', amountSen: sen(100000),
    });
    expect(res.activated).toBe(0);
  });
});

// ------------------------------------------------------------------ release

describe('M5 release tahap no-wallet', () => {
  const releaseNoWallet = (svc: MilestonesService, prisma: any, milestoneId: string) =>
    (svc as any).releaseMilestoneFundsNoWallet(prisma, milestoneId, 'buyer-1');

  it('RELEASED + baris disbursement PENDING scope MILESTONE sebesar sellerAmount (fee tertahan)', async () => {
    const disbursement = { releaseFunds: jest.fn().mockResolvedValue({ outcome: 'RELEASED' }) };
    const { svc, prisma, db } = makeSvc({ walletEnabled: false, disbursement });
    seedOrder(db);
    const m = seedMilestone(db, {
      status: MilestoneStatus.ACCEPTED,
      buyerAmount: sen(100000), sellerAmount: sen(95000),
      escrowHeld: sen(100000),
    });

    const res = await releaseNoWallet(svc, prisma, m.id);
    expect(res.skipped).toBeFalsy();
    expect(res.releasedTxId).toBe(`DANA:MILESTONE:${m.id}`);

    const after = db.orderMilestone[0];
    expect(after.status).toBe(MilestoneStatus.RELEASED);
    expect(after.escrowHeld).toBe(0n);

    // Baris durable untuk cron retry bila post-commit gagal.
    expect(db.escrowDisbursement).toHaveLength(1);
    const disb = db.escrowDisbursement[0];
    expect(disb.idempotencyKey).toBe(`MILESTONE:${m.id}`);
    expect(disb.scope).toBe('MILESTONE');
    expect(disb.sellerId).toBe('seller-1');
    expect(disb.status).toBe('PENDING');
    // Seller hanya terima sellerAmount — fee 5000 TETAP di merchant DANA.
    expect(disb.amountSen).toBe(sen(95000));

    const relEvent = db.milestoneEvent.find((e) => e.eventType === MilestoneEventType.RELEASED);
    expect(relEvent!.payload.feeAmount).toBe(sen(5000).toString());

    // Post-commit: settlement via releaseFunds.
    await (svc as any).runPostCommitMilestoneRelease(res.danaDisbursement);
    expect(disbursement.releaseFunds).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `MILESTONE:${m.id}`,
        scope: 'MILESTONE',
        sellerId: 'seller-1',
        amountSen: sen(95000),
      }),
    );
  });

  it('idempoten: release kedua di-skip', async () => {
    const { svc, prisma, db } = makeSvc({ walletEnabled: false, disbursement: { releaseFunds: jest.fn() } });
    seedOrder(db);
    const m = seedMilestone(db, {
      status: MilestoneStatus.ACCEPTED, buyerAmount: sen(100000), sellerAmount: sen(95000),
      escrowHeld: sen(100000),
    });
    const first = await releaseNoWallet(svc, prisma, m.id);
    const second = await releaseNoWallet(svc, prisma, m.id);
    expect(second.skipped).toBe(true);
    expect(second.releasedTxId).toBe(first.releasedTxId);
    expect(db.escrowDisbursement).toHaveLength(1);
  });

  it('fail-closed bila sellerAmount > buyerAmount (fee negatif)', async () => {
    const { svc, prisma, db } = makeSvc({ walletEnabled: false, disbursement: { releaseFunds: jest.fn() } });
    seedOrder(db);
    const m = seedMilestone(db, {
      status: MilestoneStatus.ACCEPTED, buyerAmount: sen(100000), sellerAmount: sen(100001),
      escrowHeld: sen(100000),
    });
    await expect(releaseNoWallet(svc, prisma, m.id)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'MILESTONE_INVARIANT_VIOLATION' }),
    });
    expect(db.escrowDisbursement).toHaveLength(0);
  });

  it('fail-closed bila bukan ACCEPTED', async () => {
    const { svc, prisma, db } = makeSvc({ walletEnabled: false, disbursement: { releaseFunds: jest.fn() } });
    seedOrder(db);
    const m = seedMilestone(db, { status: MilestoneStatus.SUBMITTED, escrowHeld: sen(100000) });
    await expect(releaseNoWallet(svc, prisma, m.id)).rejects.toThrow();
  });

  it('routing: wallet mati → cabang no-wallet; wallet hidup → cabang wallet', async () => {
    const { svc, prisma, db } = makeSvc({ walletEnabled: false, disbursement: { releaseFunds: jest.fn() } });
    seedOrder(db);
    const m = seedMilestone(db, {
      status: MilestoneStatus.ACCEPTED, buyerAmount: sen(100000), sellerAmount: sen(95000),
      escrowHeld: sen(100000),
    });
    // releaseMilestoneFunds (private) me-routing berdasar walletMode.
    const res = await (svc as any).releaseMilestoneFunds(prisma, m.id, 'buyer-1');
    expect(res.releasedTxId).toBe(`DANA:MILESTONE:${m.id}`);
    expect(db.escrowDisbursement).toHaveLength(1);
  });
});

// ------------------------------------------------------------ cancel remaining

describe('M5 cancelRemaining no-wallet (refund parsial DANA)', () => {
  function seedDanaPayment(db: Record<string, Row[]>) {
    db.paymentTransaction.push({
      id: 'pay-1', orderId: 'ord-1', purpose: PaymentPurpose.ORDER_ESCROW,
      provider: PaymentProvider.DANA, status: PaymentStatus.SUCCESS,
    });
  }

  it('refund parsial per tahap terbuka; tahap RELEASED tidak disentuh', async () => {
    const danaRefund = {
      refundAmount: jest.fn().mockResolvedValue({ refunded: true, already: false, amountSen: sen(50000) }),
    };
    const { svc, prisma, db } = makeSvc({ walletEnabled: false, danaRefund });
    seedOrder(db);
    seedDanaPayment(db);
    const m1 = seedMilestone(db, { status: MilestoneStatus.AWAITING_ACTIVATION, buyerAmount: sen(50000), escrowHeld: sen(50000) });
    const m2 = seedMilestone(db, { status: MilestoneStatus.SUBMITTED, buyerAmount: sen(50000), escrowHeld: sen(50000) });
    const m3 = seedMilestone(db, {
      status: MilestoneStatus.RELEASED, buyerAmount: sen(50000), sellerAmount: sen(47500),
      escrowHeld: 0n, releasedTxId: 'DANA:MILESTONE:released',
    });
    void m3;

    const order = db.order[0];
    const res = await (svc as any).cancelRemainingNoWallet(order, 'ord-1', 'buyer-1', MilestoneActorType.BUYER);

    // Refund DANA parsial per tahap terbuka (bukan full payment).
    expect(danaRefund.refundAmount).toHaveBeenCalledTimes(2);
    expect(danaRefund.refundAmount).toHaveBeenCalledWith(expect.objectContaining({
      paymentDbId: 'pay-1',
      amountSen: sen(50000),
      idempotencyKey: `MILESTONE_CANCEL:${m1.id}`,
    }));
    expect(danaRefund.refundAmount).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: `MILESTONE_CANCEL:${m2.id}`,
    }));

    expect(db.orderMilestone.find((m) => m.id === m1.id)!.status).toBe(MilestoneStatus.CANCELLED);
    expect(db.orderMilestone.find((m) => m.id === m2.id)!.status).toBe(MilestoneStatus.CANCELLED);
    expect(db.orderMilestone.find((m) => m.id === m3.id)!.status).toBe(MilestoneStatus.RELEASED);
    expect(res.cancelled).toBe(2);
    expect(res.refundedIdr).toBe(100000);
  });

  it('fail-closed tanpa payment DANA SUCCESS', async () => {
    const danaRefund = { refundAmount: jest.fn() };
    const { svc, prisma, db } = makeSvc({ walletEnabled: false, danaRefund });
    seedOrder(db);
    seedMilestone(db, { status: MilestoneStatus.AWAITING_ACTIVATION, escrowHeld: sen(50000) });
    const order = db.order[0];
    await expect(
      (svc as any).cancelRemainingNoWallet(order, 'ord-1', 'buyer-1', MilestoneActorType.BUYER),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'MILESTONE_CANCEL_NO_DANA_PAYMENT' }),
    });
    expect(danaRefund.refundAmount).not.toHaveBeenCalled();
    expect(db.orderMilestone[0].status).toBe(MilestoneStatus.AWAITING_ACTIVATION);
  });

  it('fail-closed bila refund DANA gagal — tahap tidak dibatalkan', async () => {
    const danaRefund = {
      refundAmount: jest.fn().mockResolvedValue({ refunded: false, reason: 'NOT_ELIGIBLE' }),
    };
    const { svc, prisma, db } = makeSvc({ walletEnabled: false, danaRefund });
    seedOrder(db);
    seedDanaPayment(db);
    seedMilestone(db, { status: MilestoneStatus.AWAITING_ACTIVATION, escrowHeld: sen(50000) });
    const order = db.order[0];
    await expect(
      (svc as any).cancelRemainingNoWallet(order, 'ord-1', 'buyer-1', MilestoneActorType.BUYER),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'MILESTONE_CANCEL_REFUND_FAILED' }),
    });
    expect(db.orderMilestone[0].status).toBe(MilestoneStatus.AWAITING_ACTIVATION);
  });
});

describe('M5 adminCancelMilestonesNoWallet (routing anti over-refund)', () => {
  it('order bertahap → routed=true, refund parsial per tahap; bukan ORDER:FULL', async () => {
    const danaRefund = {
      refundAmount: jest.fn().mockResolvedValue({ refunded: true, already: false, amountSen: sen(50000) }),
    };
    const { svc, prisma, db } = makeSvc({ walletEnabled: false, danaRefund });
    seedOrder(db);
    db.paymentTransaction.push({
      id: 'pay-1', orderId: 'ord-1', purpose: PaymentPurpose.ORDER_ESCROW,
      provider: PaymentProvider.DANA, status: PaymentStatus.SUCCESS,
    });
    seedMilestone(db, { status: MilestoneStatus.AWAITING_ACTIVATION, buyerAmount: sen(50000), escrowHeld: sen(50000) });
    seedMilestone(db, {
      status: MilestoneStatus.RELEASED, buyerAmount: sen(50000), sellerAmount: sen(47500),
      escrowHeld: 0n, releasedTxId: 'DANA:MILESTONE:x',
    });

    const res = await (svc as any).adminCancelMilestonesNoWallet('ord-1', 'admin-1', 'test');
    expect(res.routed).toBe(true);
    expect(res.cancelled).toBe(1);
    // Hanya tahap terbuka yang di-refund parsial.
    expect(danaRefund.refundAmount).toHaveBeenCalledTimes(1);
    expect(danaRefund.refundAmount).toHaveBeenCalledWith(expect.objectContaining({
      amountSen: sen(50000),
      idempotencyKey: expect.stringMatching(/^MILESTONE_CANCEL:/),
    }));
    // Tidak ada refund ORDER:FULL.
    for (const c of danaRefund.refundAmount.mock.calls) {
      expect(c[0].idempotencyKey).not.toMatch(/^ORDER:/);
    }
  });

  it('order tanpa milestone → routed=false (caller lanjut refundOrderEscrow)', async () => {
    const { svc, prisma, db } = makeSvc({ walletEnabled: false, danaRefund: { refundAmount: jest.fn() } });
    seedOrder(db);
    const res = await (svc as any).adminCancelMilestonesNoWallet('ord-1', 'admin-1', 'test');
    expect(res.routed).toBe(false);
  });

  it('wallet hidup → routed=false', async () => {
    const { svc, prisma, db } = makeSvc({ walletEnabled: true, danaRefund: { refundAmount: jest.fn() } });
    seedOrder(db);
    seedMilestone(db, { status: MilestoneStatus.AWAITING_ACTIVATION, escrowHeld: sen(50000) });
    const res = await (svc as any).adminCancelMilestonesNoWallet('ord-1', 'admin-1', 'test');
    expect(res.routed).toBe(false);
  });
});
