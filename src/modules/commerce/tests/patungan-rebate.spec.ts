import { computePatunganRebateTx, createPatunganRebateLedgerTx } from '../patungan-rebate';
import { PatunganParticipantStatus, PatunganStatus, WalletTransactionType } from '@prisma/client';

// M6 (SEC-B ronde 2): overfunding patungan HARUS mengurangi beban peserta
// secara nyata — bukan sekadar angka informatif di response.

const SEN = 100n;
const idr = (n: number) => BigInt(n) * SEN;

function mockTx(overrides: Record<string, any> = {}) {
  return {
    patunganParticipant: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      ...overrides.patunganParticipant,
    },
    patunganGroup: { findUnique: jest.fn(), ...overrides.patunganGroup },
    walletTransaction: { findFirst: jest.fn(), create: jest.fn(), ...overrides.walletTransaction },
  };
}

describe('computePatunganRebateTx (M6)', () => {
  it('angka konkret: target 1.000.000, 5 × 250.000 → rebate 50.000/orang', async () => {
    const tx = mockTx();
    tx.patunganParticipant.findUnique.mockResolvedValue({ id: 'pp1', groupId: 'g1', status: PatunganParticipantStatus.PAID });
    tx.patunganGroup.findUnique.mockResolvedValue({ status: PatunganStatus.TARGET_REACHED, targetAmount: idr(1000000) });
    tx.walletTransaction.findFirst.mockResolvedValue(null);
    tx.patunganParticipant.findMany.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({ amount: idr(250000), id: `pp${i}` })),
    );
    const res = await computePatunganRebateTx(tx as never, 'order-db-1');
    // Overfunding = 1.250.000 − 1.000.000 = 250.000; /5 = 50.000 per orang.
    expect(res).toEqual({ participantId: 'pp1', groupId: 'g1', rebateSen: idr(50000) });
  });

  it('sisa pembulatan (dust) di-floor: 3 × 400.000, target 1.000.000 → 66.666/orang', async () => {
    const tx = mockTx();
    tx.patunganParticipant.findUnique.mockResolvedValue({ id: 'pp1', groupId: 'g1', status: PatunganParticipantStatus.RELEASED });
    tx.patunganGroup.findUnique.mockResolvedValue({ status: PatunganStatus.RELEASED, targetAmount: idr(1000000) });
    tx.walletTransaction.findFirst.mockResolvedValue(null);
    tx.patunganParticipant.findMany.mockResolvedValue([
      { amount: idr(400000) }, { amount: idr(400000) }, { amount: idr(400000) },
    ]);
    const res = await computePatunganRebateTx(tx as never, 'order-db-1');
    // Overfunding 200.000 / 3 = 66.666 (floor 6.666.666 sen), dust 2 sen ke host.
    expect(res?.rebateSen).toBe(6666666n);
  });

  it('order tanpa peserta patungan → null (order normal tidak tersentuh)', async () => {
    const tx = mockTx();
    tx.patunganParticipant.findUnique.mockResolvedValue(null);
    expect(await computePatunganRebateTx(tx as never, 'order-db-1')).toBeNull();
  });

  it('grup masih OPEN → null (belum waktunya rebate)', async () => {
    const tx = mockTx();
    tx.patunganParticipant.findUnique.mockResolvedValue({ id: 'pp1', groupId: 'g1', status: PatunganParticipantStatus.PAID });
    tx.patunganGroup.findUnique.mockResolvedValue({ status: PatunganStatus.OPEN, targetAmount: idr(1000000) });
    expect(await computePatunganRebateTx(tx as never, 'order-db-1')).toBeNull();
  });

  it('tidak ada overfunding → null', async () => {
    const tx = mockTx();
    tx.patunganParticipant.findUnique.mockResolvedValue({ id: 'pp1', groupId: 'g1', status: PatunganParticipantStatus.PAID });
    tx.patunganGroup.findUnique.mockResolvedValue({ status: PatunganStatus.CONTEST, targetAmount: idr(1000000) });
    tx.walletTransaction.findFirst.mockResolvedValue(null);
    tx.patunganParticipant.findMany.mockResolvedValue([{ amount: idr(500000) }, { amount: idr(500000) }]);
    expect(await computePatunganRebateTx(tx as never, 'order-db-1')).toBeNull();
  });

  it('idempoten: baris rebate sudah ada → null (tidak double-rebate)', async () => {
    const tx = mockTx();
    tx.patunganParticipant.findUnique.mockResolvedValue({ id: 'pp1', groupId: 'g1', status: PatunganParticipantStatus.PAID });
    tx.patunganGroup.findUnique.mockResolvedValue({ status: PatunganStatus.TARGET_REACHED, targetAmount: idr(1000000) });
    tx.walletTransaction.findFirst.mockResolvedValue({ id: 'wt-rebate' });
    const res = await computePatunganRebateTx(tx as never, 'order-db-1');
    expect(res).toBeNull();
    expect(tx.patunganParticipant.findMany).not.toHaveBeenCalled();
  });

  it('peserta berstatus PENDING (belum bayar) → null', async () => {
    const tx = mockTx();
    tx.patunganParticipant.findUnique.mockResolvedValue({ id: 'pp1', groupId: 'g1', status: PatunganParticipantStatus.PENDING });
    expect(await computePatunganRebateTx(tx as never, 'order-db-1')).toBeNull();
  });

  it('createPatunganRebateLedgerTx menulis baris ORDER_REFUND yang benar', async () => {
    const tx = mockTx();
    await createPatunganRebateLedgerTx(tx as never, {
      txId: 'WLT-20260101-0001',
      buyerWalletId: 'w-buyer',
      orderDbId: 'order-db-1',
      orderPublicId: 'ORD-1',
      groupId: 'g1',
      rebateSen: idr(50000),
      buyerAvailableBefore: idr(100000),
    });
    expect(tx.walletTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        txId: 'WLT-20260101-0001',
        walletId: 'w-buyer',
        type: WalletTransactionType.ORDER_REFUND,
        amount: idr(50000),
        balanceBefore: idr(100000),
        balanceAfter: idr(150000),
        orderId: 'order-db-1',
        description: expect.stringContaining('group=g1 order=ORD-1'),
      }),
    });
  });
});
