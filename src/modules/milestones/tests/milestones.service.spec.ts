// GAP-C (G200): test state machine + keuangan milestone.
//
// Fake PrismaService in-memory mengemulasikan perilaku updateMany bersyarat
// (concurrency guard) agar logika idempotensi & guard benar-benar teruji.
import { MilestonesService, splitMilestoneFunds } from '../milestones.service';
import { MilestoneStatus } from '@prisma/client';

interface Row { [k: string]: any }

function makeFakePrisma() {
  const db: Record<string, Row[]> = {
    order: [],
    orderMilestone: [],
    milestoneEvent: [],
    milestoneEvidence: [],
    wallet: [],
    walletTransaction: [],
    dispute: [],
    notification: [],
    orderStatusHistory: [],
  };
  let seq = 0;
  const nid = (p: string) => `${p}-${++seq}`;

  const matchWhere = (row: Row, where: any): boolean => {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
      if (k === 'NOT') { if (matchWhere(row, v)) return false; continue; }
      if (v === null) { if (row[k] !== null && row[k] !== undefined) return false; continue; } // Prisma: null cocok NULL
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        if ('equals' in (v as any)) { if (row[k] !== (v as any).equals) return false; continue; }
        if ('in' in (v as any)) { if (!(v as any).in.includes(row[k])) return false; continue; }
        if ('gte' in (v as any) || 'gt' in (v as any) || 'lt' in (v as any)) {
          const rv = row[k];
          if ('gte' in (v as any) && !(rv >= (v as any).gte)) return false;
          if ('gt' in (v as any) && !(rv > (v as any).gt)) return false;
          if ('lt' in (v as any) && !(rv < (v as any).lt)) return false;
          continue;
        }
        if ('path' in (v as any)) {
          // metadata: { path: ['milestoneId'], equals: id }
          let cur = row[k];
          for (const p of (v as any).path) cur = cur?.[p];
          if (cur !== (v as any).equals) return false;
          continue;
        }
        throw new Error('unsupported where op ' + JSON.stringify(v));
      }
      if (row[k] !== v) return false;
    }
    return true;
  };

  const isDateLike = (v: any) =>
    Object.prototype.toString.call(v) === '[object Date]';
  const applyData = (row: Row, data: any) => {
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue; // Prisma mengabaikan undefined
      if (v !== null && typeof v === 'object' && !Array.isArray(v) && !isDateLike(v)) {
        // Prisma.DbNull ter-clone menjadi {} — dalam test ini tak ada payload
        // JSON {} yang valid, jadi {} berarti "set NULL".
        if (Object.keys(v).length === 0) { row[k] = null; continue; }
        // Pertahankan tipe kolom: BigInt untuk dana, number untuk Int/version.
        if ('increment' in (v as any)) {
          const inc = (v as any).increment;
          row[k] = typeof row[k] === 'bigint' ? (row[k] as bigint) + BigInt(inc) : Number(row[k]) + Number(inc);
          continue;
        }
        if ('decrement' in (v as any)) {
          const dec = (v as any).decrement;
          row[k] = typeof row[k] === 'bigint' ? (row[k] as bigint) - BigInt(dec) : Number(row[k]) - Number(dec);
          continue;
        }
      }
      row[k] = v;
    }
  };

  const attachOrder = (name: string, r: Row | null | undefined, include: any) => {
    if (r && name === 'orderMilestone' && include?.order) {
      return { ...r, order: db.order.find((o) => o.id === r.orderId) };
    }
    if (r && name === 'order' && include?.milestones) {
      return { ...r, milestones: db.orderMilestone.filter((m) => m.orderId === r.id) };
    }
    return r ?? null;
  };

  // Seperti Prisma asli: hasil baca adalah objek terpisah — updateMany TIDAK
  // memutasi objek yang pernah di-fetch (service menyinkronkan manual).
  const copy = (r: Row) => ({ ...r });

  const table = (name: string) => ({
    findUnique: jest.fn(async ({ where, include }: any) => {
      const r = db[name].find((x) => matchWhere(x, where));
      return attachOrder(name, r ? copy(r) : r, include);
    }),
    findUniqueOrThrow: jest.fn(async ({ where, include }: any) => {
      const r = db[name].find((x) => matchWhere(x, where));
      if (!r) throw new Error(name + ' not found');
      return attachOrder(name, copy(r), include);
    }),
    findFirst: jest.fn(async ({ where }: any) => {
      const r = db[name].find((x) => matchWhere(x, where));
      return r ? copy(r) : null;
    }),
    findMany: jest.fn(async ({ where, orderBy, take }: any = {}) => {
      let rows = db[name].filter((x) => matchWhere(x, where)).map(copy);
      if (orderBy?.seq === 'asc') rows = [...rows].sort((a, b) => a.seq - b.seq);
      if (take) rows = rows.slice(0, take);
      return rows;
    }),
    count: jest.fn(async ({ where }: any = {}) => db[name].filter((x) => matchWhere(x, where)).length),
    create: jest.fn(async ({ data, select }: any) => {
      const row = { id: nid(name), createdAt: new Date(), updatedAt: new Date(), ...structuredClone(data) };
      // Default ala schema untuk orderMilestone (DB @default).
      if (name === 'orderMilestone') {
        row.revisionRounds ??= 0;
        row.escrowHeld ??= 0n;
        row.releasedTxId ??= null;
        row.changeRequest ??= null;
        row.buyerApprovedChange ??= false;
        row.sellerApprovedChange ??= false;
      }
      db[name].push(row);
      if (select) { const out: Row = {}; for (const k of Object.keys(select)) out[k] = row[k]; return out; }
      return row;
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const r = db[name].find((x) => matchWhere(x, where));
      if (!r) throw new Error(name + ' update miss');
      applyData(r, structuredClone(data));
      r.updatedAt = new Date();
      return r;
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const rows = db[name].filter((x) => matchWhere(x, where));
      for (const r of rows) { applyData(r, structuredClone(data)); r.updatedAt = new Date(); }
      return { count: rows.length };
    }),
    aggregate: jest.fn(async () => ({ _sum: {}, _count: { _all: 0 } })),
    groupBy: jest.fn(async ({ by, where }: any = {}) => {
      const rows = db[name].filter((x) => matchWhere(x, where));
      const groups = new Map<string, { values: Row; count: number }>();
      for (const r of rows) {
        const key = by.map((b: string) => String(r[b])).join('|');
        let g = groups.get(key);
        if (!g) { g = { values: Object.fromEntries(by.map((b: string) => [b, r[b]])), count: 0 }; groups.set(key, g); }
        g.count += 1;
      }
      return [...groups.values()].map((g) => ({ ...g.values, _count: { _all: g.count } }));
    }),
  });

  const txShim: any = {};
  for (const t of Object.keys(db)) txShim[t] = table(t);
  const prisma: any = {};
  for (const t of Object.keys(db)) prisma[t] = table(t);
  prisma.$transaction = jest.fn(async (cb: any) => cb(txShim));
  prisma.notification = table('notification');
  prisma.emitNotificationCreated = jest.fn();

  return { prisma, db, txShim };
}

const SEN = 100n;
const idr = (n: number) => BigInt(n) * SEN;

function seedOrder(db: Record<string, Row[]>, overrides: Partial<Row> = {}) {
  const order: Row = {
    id: 'order-1', orderId: 'ORD-1', title: 'Jasa Desain', buyerId: 'buyer-1', sellerId: 'seller-1',
    status: 'WAITING_PAYMENT',
    orderValue: idr(300000), buyerPayAmount: idr(307500), sellerReceiveAmount: idr(292500), feeAmount: idr(15000),
    ...overrides,
  };
  db.order.push(order);
  db.wallet.push({ id: 'w-buyer', userId: 'buyer-1', availableBalance: idr(1000000), escrowBalance: 0n, totalBalance: idr(1000000), version: 1, isLocked: false });
  db.wallet.push({ id: 'w-seller', userId: 'seller-1', availableBalance: 0n, escrowBalance: 0n, totalBalance: 0n, version: 1, isLocked: false });
  return order;
}

function makeService() {
  const { prisma, db } = makeFakePrisma();
  const txSerial = { getNext: jest.fn(async () => Math.floor(Math.random() * 1e9)), getNextForPrefix: jest.fn(async () => 42) };
  const svc = new MilestonesService(prisma as any, txSerial as any);
  return { svc, prisma, db };
}

describe('splitMilestoneFunds (G187)', () => {
  it('membagi proporsional dan totalnya pas (sisa pembulatan di tahap akhir)', () => {
    const amounts = [idr(100000), idr(100000), idr(100000)];
    const splits = splitMilestoneFunds(amounts, idr(307500), idr(292500));
    expect(splits).toHaveLength(3);
    const sum = (f: (s: (typeof splits)[number]) => bigint) => splits.reduce((a, s) => a + f(s), 0n);
    expect(sum((s) => s.buyerAmount)).toBe(idr(307500));
    expect(sum((s) => s.sellerAmount)).toBe(idr(292500));
    expect(sum((s) => s.feeAmount)).toBe(idr(15000));
    for (const s of splits) {
      expect(s.feeAmount).toBe(s.buyerAmount - s.sellerAmount);
      expect(s.feeAmount).toBeGreaterThanOrEqual(0n);
    }
  });

  it('tahap terakhir menyerap sisa pembulatan', () => {
    const amounts = [idr(100000), idr(100000), idr(100000)];
    const splits = splitMilestoneFunds(amounts, idr(100001), idr(99999));
    expect(splits.reduce((a, s) => a + s.buyerAmount, 0n)).toBe(idr(100001));
    expect(splits.reduce((a, s) => a + s.sellerAmount, 0n)).toBe(idr(99999));
  });
});

describe('MilestonesService lifecycle (G200)', () => {
  it('menolak total tahap != orderValue (G177)', async () => {
    const { svc, db } = makeService();
    seedOrder(db);
    await expect(
      svc.createMilestones('order-1', 'seller-1', {
        milestones: [
          { title: 'Tahap A', amountIdr: 100000 },
          { title: 'Tahap B', amountIdr: 100000 },
        ],
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('harus sama persis') });
  });

  it('menolak pembuatan oleh non-seller', async () => {
    const { svc, db } = makeService();
    seedOrder(db);
    await expect(
      svc.createMilestones('order-1', 'buyer-1', {
        milestones: [
          { title: 'Tahap A', amountIdr: 150000 },
          { title: 'Tahap B', amountIdr: 150000 },
        ],
      }),
    ).rejects.toThrow();
  });

  async function fullSetup() {
    const { svc, prisma, db } = makeService();
    // SEC-102: submit/accept hanya sah saat order PROCESSING/IN_DELIVERY —
    // seed mencerminkan alur produksi: rencana dibuat saat WAITING_PAYMENT,
    // lalu order dibayar (PROCESSING) sebelum tahap diserahkan/diterima.
    const order = seedOrder(db);
    await svc.createMilestones('order-1', 'seller-1', {
      milestones: [
        { title: 'Tahap 1', amountIdr: 150000 },
        { title: 'Tahap 2', amountIdr: 150000 },
      ],
    });
    db.order.find((o) => o.id === 'order-1')!.status = 'PROCESSING';
    // Simulasikan escrow lock penuh (seperti payOrder): buyer escrow = buyerPayAmount.
    const buyerWallet = db.wallet.find((w) => w.userId === 'buyer-1')!;
    buyerWallet.availableBalance -= order.buyerPayAmount;
    buyerWallet.escrowBalance += order.buyerPayAmount;
    await svc.activateMilestonesForOrder(prisma as any, 'order-1');
    return { svc, prisma, db, order };
  }

  it('aktivasi mengalokasikan escrowHeld = buyerAmount per tahap', async () => {
    const { db } = await fullSetup();
    const ms = db.orderMilestone;
    expect(ms).toHaveLength(2);
    expect(ms[0].status).toBe(MilestoneStatus.AWAITING_ACTIVATION);
    const total = ms.reduce((a, m) => a + m.escrowHeld, 0n);
    expect(total).toBe(idr(307500));
    expect(ms[0].buyerAmount + ms[1].buyerAmount).toBe(idr(307500));
  });

  it('alur penuh: submit → accept → release; double accept hanya 1x credit (G184/G186)', async () => {
    const { svc, db } = await fullSetup();
    const m1 = db.orderMilestone[0];
    const sellerBefore = db.wallet.find((w) => w.userId === 'seller-1')!.availableBalance;

    await svc.submitMilestone(m1.id, 'seller-1');
    expect(db.orderMilestone[0].status).toBe(MilestoneStatus.SUBMITTED);

    await svc.acceptMilestone(m1.id, 'buyer-1');
    const m1After = db.orderMilestone.find((x) => x.id === m1.id)!;
    expect(m1After.status).toBe(MilestoneStatus.RELEASED);
    expect(m1After.escrowHeld).toBe(0n);
    expect(m1After.releasedTxId).toBeTruthy();

    const sellerAfter = db.wallet.find((w) => w.userId === 'seller-1')!.availableBalance;
    expect(sellerAfter - sellerBefore).toBe(m1After.sellerAmount);

    const buyerWallet = db.wallet.find((w) => w.userId === 'buyer-1')!;
    expect(buyerWallet.escrowBalance).toBe(idr(307500) - m1After.buyerAmount);

    const releases = db.walletTransaction.filter((t) => t.type === 'MILESTONE_RELEASE');
    expect(releases).toHaveLength(2); // buyer + seller
    const fees = db.walletTransaction.filter((t) => t.type === 'FEE_DEDUCT');
    expect(fees).toHaveLength(1);
    expect(fees[0].amount).toBe(m1After.feeAmount);

    // Double accept → status bukan SUBMITTED lagi → ditolak, tidak ada credit ganda.
    await expect(svc.acceptMilestone(m1.id, 'buyer-1')).rejects.toThrow();
    expect(db.walletTransaction.filter((t) => t.type === 'MILESTONE_RELEASE')).toHaveLength(2);
    expect(db.wallet.find((w) => w.userId === 'seller-1')!.availableBalance).toBe(sellerAfter);
  });

  it('release idempoten: retry setelah RELEASED tidak menggerakkan dana (G186)', async () => {
    const { svc, db } = await fullSetup();
    const m1 = db.orderMilestone[0];
    await svc.submitMilestone(m1.id, 'seller-1');
    await svc.acceptMilestone(m1.id, 'buyer-1');
    const sellerBal = db.wallet.find((w) => w.userId === 'seller-1')!.availableBalance;
    const res = await svc.releaseMilestone(m1.id, 'buyer-1');
    expect(res.alreadyReleased).toBe(true);
    expect(db.wallet.find((w) => w.userId === 'seller-1')!.availableBalance).toBe(sellerBal);
    expect(db.walletTransaction.filter((t) => t.type === 'MILESTONE_RELEASE')).toHaveLength(2);
  });

  it('batas revisi ditegakkan (G183)', async () => {
    const { svc, db } = await fullSetup();
    const m1 = db.orderMilestone[0];
    await svc.submitMilestone(m1.id, 'seller-1');
    await svc.requestRevision(m1.id, 'buyer-1', { note: 'revisi 1' });
    // maxRevisionRounds default 2 → revisi ke-2 masih boleh
    await svc.submitMilestone(m1.id, 'seller-1');
    await svc.requestRevision(m1.id, 'buyer-1', { note: 'revisi 2' });
    await svc.submitMilestone(m1.id, 'seller-1');
    await expect(svc.requestRevision(m1.id, 'buyer-1', { note: 'revisi 3' })).rejects.toMatchObject({
      message: expect.stringContaining('Batas revisi'),
    });
  });

  it('cancel remaining tidak menyentuh tahap released; refund escrow sisa (G189/G194)', async () => {
    const { svc, db } = await fullSetup();
    const [m1, m2] = db.orderMilestone;
    await svc.submitMilestone(m1.id, 'seller-1');
    await svc.acceptMilestone(m1.id, 'buyer-1');

    const sellerBalAfterRelease = db.wallet.find((w) => w.userId === 'seller-1')!.availableBalance;
    const buyerAvailBefore = db.wallet.find((w) => w.userId === 'buyer-1')!.availableBalance;

    const res = await svc.cancelRemaining('order-1', 'buyer-1');
    expect(res.cancelled).toBe(1);

    // Tahap released tidak berubah.
    const m1After = db.orderMilestone.find((x) => x.id === m1.id)!;
    expect(m1After.status).toBe(MilestoneStatus.RELEASED);
    expect(db.wallet.find((w) => w.userId === 'seller-1')!.availableBalance).toBe(sellerBalAfterRelease);

    // Tahap 2 dibatalkan + escrow-nya kembali ke buyer.
    const m2After = db.orderMilestone.find((x) => x.id === m2.id)!;
    expect(m2After.status).toBe(MilestoneStatus.CANCELLED);
    expect(m2After.escrowHeld).toBe(0n);
    const buyerWallet = db.wallet.find((w) => w.userId === 'buyer-1')!;
    expect(buyerWallet.availableBalance - buyerAvailBefore).toBe(m2.buyerAmount);
    const refunds = db.walletTransaction.filter((t) => t.type === 'ORDER_REFUND');
    expect(refunds).toHaveLength(1);
    expect(refunds[0].amount).toBe(m2.buyerAmount);
  });

  it('sengketa satu tahap tidak mengubah tahap lain (G190)', async () => {
    const { svc, db } = await fullSetup();
    const [m1, m2] = db.orderMilestone;
    await svc.submitMilestone(m2.id, 'seller-1');
    await svc.openMilestoneDispute(m2.id, 'buyer-1', 'Hasil tidak sesuai');
    expect(db.orderMilestone.find((x) => x.id === m2.id)!.status).toBe(MilestoneStatus.DISPUTED);
    expect(db.orderMilestone.find((x) => x.id === m1.id)!.status).toBe(MilestoneStatus.AWAITING_ACTIVATION);
    const d = db.dispute[0];
    expect(d.milestoneId).toBe(m2.id);
    expect(d.initiatorUserId).toBe('buyer-1');
  });

  it('change request butuh persetujuan dua pihak (G179)', async () => {
    const { svc, db } = await fullSetup();
    const m1 = db.orderMilestone[0];
    await svc.requestChange(m1.id, 'seller-1', { change: { title: 'Tahap 1 revisi judul' } });
    // Buyer menyetujui → diterapkan.
    await svc.approveChange(m1.id, 'buyer-1');
    expect(db.orderMilestone.find((x) => x.id === m1.id)!.title).toBe('Tahap 1 revisi judul');
    // Pengaju tidak bisa menyetujui sendiri.
    await svc.requestChange(m1.id, 'buyer-1', { change: { title: 'X' } });
    await expect(svc.approveChange(m1.id, 'buyer-1')).rejects.toThrow();
  });

  it('reconcileOrder mendeteksi invariant rusak (G199)', async () => {
    const { svc, db } = await fullSetup();
    const ok = await svc.reconcileOrder('order-1');
    expect(ok.ok).toBe(true);
    // Rusak manual: ubah amount salah satu tahap.
    db.orderMilestone[0].amount += 1n;
    const bad = await svc.reconcileOrder('order-1');
    expect(bad.ok).toBe(false);
    expect(bad.checks.filter((c: any) => !c.ok).length).toBeGreaterThan(0);
  });

  it('response dibaca memakai IDR, bukan sen (kontrak mobile)', async () => {
    const { svc } = await fullSetup();
    const list = await svc.getOrderMilestones('order-1', 'buyer-1');
    expect(list.summary.totalAmount).toBe(300000);
    expect(list.milestones).toHaveLength(2);
    expect(list.milestones[0].amount).toBe(150000);
    expect(list.milestones[0].orderId).toBe('ORD-1');
    expect(list.milestones[0].buyerAmount + list.milestones[1].buyerAmount).toBe(307500);
    expect(list.milestones[0].sellerAmount + list.milestones[1].sellerAmount).toBe(292500);
    expect(list.milestones[0].feeAmount + list.milestones[1].feeAmount).toBe(15000);
    const detail = await svc.getMilestone(list.milestones[0].id, 'buyer-1');
    expect(detail.amount).toBe(150000);
    expect(detail.escrowHeld).toBe(detail.buyerAmount);
  });

  it('finalisasi: semua tahap released → order COMPLETED tanpa gerakan dana tambahan', async () => {
    const { svc, db } = await fullSetup();
    db.order.find((o) => o.id === 'order-1')!.status = 'IN_DELIVERY';
    const sellerBefore = db.wallet.find((w) => w.userId === 'seller-1')!.availableBalance;
    for (const m of db.orderMilestone) {
      await svc.submitMilestone(m.id, 'seller-1');
      await svc.acceptMilestone(m.id, 'buyer-1');
    }
    const order = db.order.find((o) => o.id === 'order-1')!;
    expect(order.status).toBe('COMPLETED');
    expect(order.completedAt).toBeTruthy();
    // Dana hanya bergerak per tahap: total kredit seller = sellerReceiveAmount.
    const sellerAfter = db.wallet.find((w) => w.userId === 'seller-1')!.availableBalance;
    expect(sellerAfter - sellerBefore).toBe(idr(292500));
    // Riwayat status tercatat.
    expect(db.orderStatusHistory).toHaveLength(1);
    expect(db.orderStatusHistory[0].toStatus).toBe('COMPLETED');
  });

  it('finalisasi: cancel remaining semua tahap → order CANCELLED', async () => {
    const { svc, db } = await fullSetup();
    db.order.find((o) => o.id === 'order-1')!.status = 'IN_DELIVERY';
    await svc.cancelRemaining('order-1', 'buyer-1');
    const order = db.order.find((o) => o.id === 'order-1')!;
    expect(order.status).toBe('CANCELLED');
    expect(db.orderStatusHistory[0].toStatus).toBe('CANCELLED');
  });

  it('finalisasi tidak berjalan bila masih ada tahap terbuka', async () => {
    const { svc, db } = await fullSetup();
    db.order.find((o) => o.id === 'order-1')!.status = 'IN_DELIVERY';
    const m1 = db.orderMilestone[0];
    await svc.submitMilestone(m1.id, 'seller-1');
    await svc.acceptMilestone(m1.id, 'buyer-1');
    expect(db.order.find((o) => o.id === 'order-1')!.status).toBe('IN_DELIVERY');
    expect(db.orderStatusHistory).toHaveLength(0);
  });

  it('SEC-102: submit ditolak saat order DISPUTED', async () => {
    const { svc, db } = await fullSetup();
    db.order.find((o) => o.id === 'order-1')!.status = 'DISPUTED';
    const m1 = db.orderMilestone[0];
    await expect(svc.submitMilestone(m1.id, 'seller-1')).rejects.toMatchObject({
      message: expect.stringContaining('PROCESSING'),
    });
    expect(db.orderMilestone[0].status).toBe(MilestoneStatus.AWAITING_ACTIVATION);
  });

  it('SEC-102: accept ditolak saat order DISPUTED (dana tidak boleh cair)', async () => {
    const { svc, db } = await fullSetup();
    const m1 = db.orderMilestone[0];
    await svc.submitMilestone(m1.id, 'seller-1');
    db.order.find((o) => o.id === 'order-1')!.status = 'DISPUTED';
    const sellerBefore = db.wallet.find((w) => w.userId === 'seller-1')!.availableBalance;
    await expect(svc.acceptMilestone(m1.id, 'buyer-1')).rejects.toMatchObject({
      message: expect.stringContaining('PROCESSING'),
    });
    expect(db.orderMilestone[0].status).toBe(MilestoneStatus.SUBMITTED);
    expect(db.wallet.find((w) => w.userId === 'seller-1')!.availableBalance).toBe(sellerBefore);
  });

  it('SEC-102: submit ditolak untuk status non-aktif lain (CANCELLED/COMPLETED/WAITING_PAYMENT)', async () => {
    for (const status of ['CANCELLED', 'COMPLETED', 'WAITING_PAYMENT']) {
      const { svc, db } = await fullSetup();
      db.order.find((o) => o.id === 'order-1')!.status = status;
      const m1 = db.orderMilestone[0];
      await expect(svc.submitMilestone(m1.id, 'seller-1')).rejects.toThrow();
    }
  });

  it('SEC-102: submit/accept tetap boleh saat IN_DELIVERY', async () => {
    const { svc, db } = await fullSetup();
    db.order.find((o) => o.id === 'order-1')!.status = 'IN_DELIVERY';
    const m1 = db.orderMilestone[0];
    await svc.submitMilestone(m1.id, 'seller-1');
    expect(db.orderMilestone[0].status).toBe(MilestoneStatus.SUBMITTED);
    await svc.acceptMilestone(m1.id, 'buyer-1');
    expect(db.orderMilestone.find((x) => x.id === m1.id)!.status).toBe(MilestoneStatus.RELEASED);
  });

  it('SEC-102: releaseMilestone (retry) ditolak saat order DISPUTED — escrow tidak cair di tengah adjudikasi', async () => {
    const { svc, db } = await fullSetup();
    const m1 = db.orderMilestone[0];
    m1.status = MilestoneStatus.ACCEPTED; // stuck: belum release, jalur retry publik
    db.order.find((o) => o.id === 'order-1')!.status = 'DISPUTED';
    const sellerBefore = db.wallet.find((w) => w.userId === 'seller-1')!.availableBalance;
    await expect(svc.releaseMilestone(m1.id, 'buyer-1')).rejects.toMatchObject({
      message: expect.stringContaining('PROCESSING'),
    });
    expect(db.orderMilestone.find((x) => x.id === m1.id)!.status).toBe(MilestoneStatus.ACCEPTED);
    expect(db.wallet.find((w) => w.userId === 'seller-1')!.availableBalance).toBe(sellerBefore);
  });

  it('SEC-102: cancelRemaining ditolak saat order DISPUTED — refund hanya via adjudikasi', async () => {
    const { svc, db } = await fullSetup();
    db.order.find((o) => o.id === 'order-1')!.status = 'DISPUTED';
    const buyerBefore = db.wallet.find((w) => w.userId === 'buyer-1')!.availableBalance;
    await expect(svc.cancelRemaining('order-1', 'buyer-1')).rejects.toMatchObject({
      message: expect.stringContaining('PROCESSING'),
    });
    expect(db.wallet.find((w) => w.userId === 'buyer-1')!.availableBalance).toBe(buyerBefore);
  });
});
