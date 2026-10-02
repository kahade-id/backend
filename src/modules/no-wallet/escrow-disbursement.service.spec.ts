import { EscrowDisbursementScope, EscrowDisbursementStatus } from '@prisma/client';
import { EscrowDisbursementService } from './escrow-disbursement.service';

jest.mock('../../common/utils/crypto.util', () => {
  const actual = jest.requireActual('../../common/utils/crypto.util');
  const decrypted: Record<string, string> = {
    'encrypted-123': '1234567890',
    'encrypted-name': 'SELLER NAME',
  };
  return { ...actual, decryptAES: async (s: string) => decrypted[s] ?? (() => { throw new Error('bad ciphertext'); })() };
});

const bank = {
  bankCode: 'BCA',
  accountNumber: 'encrypted-123',
  accountName: 'encrypted-name',
};

function buildDeps(overrides: Record<string, unknown> = {}) {
  const rows: Record<string, unknown> = {};
  const rowsById: Record<string, any> = {};
  const prisma = {
    order: { findUnique: jest.fn(async () => null) },
    bankAccount: { findFirst: jest.fn(async () => bank) },
    escrowDisbursement: {
      findUnique: jest.fn(async ({ where }: { where: { idempotencyKey?: string; id?: string } }) => {
        if (where.id) return rowsById[where.id] ?? null;
        return rows[where.idempotencyKey!] ?? null;
      }),
      create: jest.fn(async ({ data }: { data: unknown }) => {
        const row = { id: 'disb-1', status: EscrowDisbursementStatus.PENDING, ...(data as object) };
        rows[(data as { idempotencyKey: string }).idempotencyKey] = row;
        rowsById[row.id] = row;
        return row;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: unknown }) => {
        const row = { ...(rowsById[where.id] ?? { id: where.id }), ...(data as object) };
        rowsById[where.id] = row;
        return row;
      }),
      // SEC-106: semantik kondisional seperti Prisma asli — hanya baris yang
      // statusnya cocok yang di-update; count dipakai sebagai klaim atomik.
      updateMany: jest.fn(async ({ where, data }: { where: { id: string; status?: { in: string[] } }; data: unknown }) => {
        const row = rowsById[where.id];
        if (!row) return { count: 0 };
        if (where.status && !where.status.in.includes(row.status)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
      findMany: jest.fn(async () => []),
    },
  };
  const danaDisbursement = {
    bankAccountInquiry: jest.fn(async () => ({ verified: true, accountName: 'SELLER NAME' })),
    transferToBank: jest.fn(async () => ({ status: 'SUCCESS', referenceNo: 'DANA-DSB-1' })),
  };
  const walletMode = { isWalletEnabled: jest.fn(() => false) };
  const notificationQueue = { enqueue: jest.fn(async () => undefined) };
  const svc = new EscrowDisbursementService(
    prisma as never,
    danaDisbursement as never,
    walletMode as never,
    notificationQueue as never,
  );
  // Seed baris langsung ke store by-id (untuk jalur settle/retryDue).
  const seedRow = (row: Record<string, unknown>) => {
    const full = { status: EscrowDisbursementStatus.PENDING, ...row };
    rowsById[row.id as string] = full;
    if (row.idempotencyKey) rows[row.idempotencyKey as string] = full;
    return full;
  };
  return { svc, prisma, danaDisbursement, walletMode, notificationQueue, seedRow, ...overrides };
}

describe('EscrowDisbursementService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('menolak release bila order bukan COMPLETED', async () => {
    const { svc, prisma } = buildDeps();
    (prisma.order.findUnique as jest.Mock).mockResolvedValue({ id: 'o-1', status: 'PROCESSING', sellerId: 's-1', buyerPayAmount: BigInt(1500000), sellerReceiveAmount: BigInt(1480000) });
    await expect(svc.releaseForOrder('o-1')).rejects.toThrow('ORDER_NOT_RELEASE_ELIGIBLE');
  });

  it('release sukses: inquiry terverifikasi + transfer SUCCESS → status SUCCESS', async () => {
    const { svc, prisma, danaDisbursement } = buildDeps();
    (prisma.order.findUnique as jest.Mock).mockResolvedValue({
      id: 'o-1', status: 'COMPLETED', sellerId: 's-1', buyerPayAmount: BigInt(1500000), sellerReceiveAmount: BigInt(1480000),
    });

    const res = await svc.releaseForOrder('o-1');

    expect(res.outcome).toBe('RELEASED');
    expect(res.outcome === 'RELEASED' && res.danaReferenceNo).toBe('DANA-DSB-1');
    // inquiry jalan SEBELUM transfer (anti salah transfer)
    expect(danaDisbursement.bankAccountInquiry).toHaveBeenCalledWith(
      expect.objectContaining({ beneficiaryBankCode: '014', amountIdr: 14800 }), // BCA → SNAP 014
    );
    // Akuntansi: yang dicairkan = sellerReceiveAmount (14800 IDR), bukan buyerPayAmount —
    // platform fee tertahan di akun merchant DANA.
    const creates = (prisma.escrowDisbursement.create as jest.Mock).mock.calls as any[][];
    expect(creates[0][0].data.amountSen).toBe(BigInt(1480000));
    expect(danaDisbursement.transferToBank as jest.Mock).toHaveBeenCalledTimes(1);
    const tCalls = (danaDisbursement.transferToBank as jest.Mock).mock.calls as any[][];
    const ref1 = tCalls[0][0].partnerReferenceNo;
    expect(ref1).toMatch(/^DSB-/);
    // baris ditandai SUCCESS
    const updates = (prisma.escrowDisbursement.update as jest.Mock).mock.calls as any[][];
    expect(updates[updates.length - 1][0].data.status).toBe(EscrowDisbursementStatus.SUCCESS);
  });

  it('idempoten: row SUCCESS existing → tanpa transfer ulang', async () => {
    const { svc, prisma, danaDisbursement } = buildDeps();
    (prisma.order.findUnique as jest.Mock).mockResolvedValue({
      id: 'o-1', status: 'COMPLETED', sellerId: 's-1', buyerPayAmount: BigInt(1500000), sellerReceiveAmount: BigInt(1480000),
    });
    prisma.escrowDisbursement.findUnique.mockResolvedValue({
      id: 'disb-old',
      idempotencyKey: 'ORDER:o-1',
      status: EscrowDisbursementStatus.SUCCESS,
      danaReferenceNo: 'DANA-OLD',
    });
    const res = await svc.releaseForOrder('o-1');
    expect(res).toEqual({ outcome: 'RELEASED', disbursementId: 'disb-old', danaReferenceNo: 'DANA-OLD' });
    expect(danaDisbursement.transferToBank).not.toHaveBeenCalled();
  });

  it('fail-closed: seller tanpa rekening → HELD_NO_BANK + notifikasi (tanpa transfer)', async () => {
    const { svc, prisma, danaDisbursement, notificationQueue } = buildDeps();
    (prisma.bankAccount.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.order.findUnique as jest.Mock).mockResolvedValue({
      id: 'o-2', status: 'COMPLETED', sellerId: 's-2', buyerPayAmount: BigInt(1500000), sellerReceiveAmount: BigInt(1480000),
    });

    const res = await svc.releaseForOrder('o-2');

    expect(res.outcome).toBe('HELD_NO_BANK');
    expect(danaDisbursement.bankAccountInquiry).not.toHaveBeenCalled();
    expect(danaDisbursement.transferToBank).not.toHaveBeenCalled();
    expect(notificationQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 's-2', type: expect.anything() }),
    );
  });

  it('fail-closed: nama rekening inquiry mismatch → FAILED, transfer TIDAK jalan', async () => {
    const { svc, prisma, danaDisbursement } = buildDeps();
    danaDisbursement.bankAccountInquiry.mockResolvedValue({ verified: true, accountName: 'ORANG LAIN' });
    (prisma.order.findUnique as jest.Mock).mockResolvedValue({
      id: 'o-3', status: 'COMPLETED', sellerId: 's-1', buyerPayAmount: BigInt(1500000), sellerReceiveAmount: BigInt(1480000),
    });

    const res = await svc.releaseForOrder('o-3');

    expect(res.outcome).toBe('PENDING'); // FAILED di DB, menunggu retry scheduler
    expect(danaDisbursement.transferToBank).not.toHaveBeenCalled();
    const updates = (prisma.escrowDisbursement.update as jest.Mock).mock.calls as any[][];
    expect(updates[updates.length - 1][0].data.status).toBe(EscrowDisbursementStatus.FAILED);
    const lastError = updates[updates.length - 1][0].data.lastError as string;
    expect(lastError).toMatch(/BANK_ACCOUNT_NAME_MISMATCH/);
    // SEC-205: nama rekening plaintext TIDAK boleh ada di lastError DB/log —
    // hanya flag + SHA-256 hash.
    expect(lastError).not.toContain('SELLER NAME');
    expect(lastError).not.toContain('ORANG LAIN');
    expect(lastError).toMatch(/sha256\(terdaftar\)=[0-9a-f]{64}/);
    expect(lastError).toMatch(/sha256\(inquiry\)=[0-9a-f]{64}/);
  });

  it('transfer error → FAILED + lastError (retry aman via idempotencyKey)', async () => {
    const { svc, prisma, danaDisbursement } = buildDeps();
    danaDisbursement.transferToBank.mockRejectedValue(new Error('DANA timeout'));
    (prisma.order.findUnique as jest.Mock).mockResolvedValue({
      id: 'o-4', status: 'COMPLETED', sellerId: 's-1', buyerPayAmount: BigInt(1500000), sellerReceiveAmount: BigInt(1480000),
    });

    const res = await svc.releaseForOrder('o-4');

    expect(res.outcome).toBe('PENDING');
    const updates = (prisma.escrowDisbursement.update as jest.Mock).mock.calls as any[][];
    expect(updates[updates.length - 1][0].data.lastError).toMatch(/TRANSFER_ERROR: DANA timeout/);
  });

  it('transfer PROCESSING → status PROCESSING (menunggu notify)', async () => {
    const { svc, prisma, danaDisbursement } = buildDeps();
    danaDisbursement.transferToBank.mockResolvedValue({ status: 'PROCESSING', referenceNo: 'DANA-P1' });
    (prisma.order.findUnique as jest.Mock).mockResolvedValue({
      id: 'o-5', status: 'COMPLETED', sellerId: 's-1', buyerPayAmount: BigInt(1500000), sellerReceiveAmount: BigInt(1480000),
    });

    const res = await svc.releaseForOrder('o-5');

    expect(res.outcome).toBe('PENDING');
    const updates = (prisma.escrowDisbursement.update as jest.Mock).mock.calls as any[][];
    expect(updates[updates.length - 1][0].data.status).toBe(EscrowDisbursementStatus.PROCESSING);
  });

  it('fail-closed: tanpa sellerReceiveAmount valid → tolak tanpa transfer', async () => {
    const { svc, prisma, danaDisbursement } = buildDeps();
    (prisma.order.findUnique as jest.Mock).mockResolvedValue({
      id: 'o-6', status: 'COMPLETED', sellerId: 's-1', buyerPayAmount: BigInt(1500000), sellerReceiveAmount: null,
    });
    await expect(svc.releaseForOrder('o-6')).rejects.toThrow('ORDER_NOT_RELEASE_ELIGIBLE');
    expect(danaDisbursement.transferToBank).not.toHaveBeenCalled();
  });

  it('retryDue memproses baris PENDING/FAILED', async () => {
    const { svc, prisma, danaDisbursement, seedRow } = buildDeps();
    seedRow({ id: 'd-1', idempotencyKey: 'ORDER:o-9', sellerId: 's-1', amountSen: BigInt(1500000), danaPartnerReferenceNo: null });
    (prisma.escrowDisbursement.findMany as jest.Mock).mockResolvedValue([
      { id: 'd-1', idempotencyKey: 'ORDER:o-9', sellerId: 's-1', amountSen: BigInt(1500000), danaPartnerReferenceNo: null, status: EscrowDisbursementStatus.PENDING },
    ]);
    const n = await svc.retryDue(10);
    expect(n).toBe(1);
    expect(danaDisbursement.transferToBank as jest.Mock).toHaveBeenCalledTimes(1);
  });

  describe('BAD-001: CANCELLED = terminal (tidak bisa revive)', () => {
    it('releaseFunds pada baris CANCELLED melempar DISBURSEMENT_CANCELLED, tanpa transfer', async () => {
      const { svc, prisma, danaDisbursement } = buildDeps();
      prisma.escrowDisbursement.findUnique.mockResolvedValue({
        id: 'disb-cancelled',
        idempotencyKey: 'ORDER:o-x',
        status: EscrowDisbursementStatus.CANCELLED,
      });
      await expect(
        svc.releaseFunds({
          idempotencyKey: 'ORDER:o-x',
          scope: EscrowDisbursementScope.ORDER_ESCROW,
          sellerId: 's-1',
          amountSen: BigInt(1000000),
          reason: 'coba revive',
        }),
      ).rejects.toThrow('DISBURSEMENT_CANCELLED');
      expect(danaDisbursement.bankAccountInquiry).not.toHaveBeenCalled();
      expect(danaDisbursement.transferToBank).not.toHaveBeenCalled();
    });

    it('settle() langsung pada baris CANCELLED juga melempar (defense-in-depth)', async () => {
      const { svc, danaDisbursement } = buildDeps();
      const row = {
        id: 'd-x',
        idempotencyKey: 'ORDER:o-x',
        sellerId: 's-1',
        amountSen: BigInt(1000000),
        danaPartnerReferenceNo: null,
        orderId: 'o-x',
        status: EscrowDisbursementStatus.CANCELLED,
      };
      await expect((svc as any).settle(row)).rejects.toThrow('DISBURSEMENT_CANCELLED');
      expect(danaDisbursement.transferToBank).not.toHaveBeenCalled();
    });
  });

  describe('SEC-106: klaim atomik sebelum transfer', () => {
    it('dua settle konkuren — hanya satu yang transfer', async () => {
      const { svc, danaDisbursement, seedRow } = buildDeps();
      seedRow({
        id: 'd-c',
        idempotencyKey: 'ORDER:o-c',
        sellerId: 's-1',
        amountSen: BigInt(1500000),
        danaPartnerReferenceNo: null,
        orderId: 'o-c',
      });
      const row = {
        id: 'd-c',
        idempotencyKey: 'ORDER:o-c',
        sellerId: 's-1',
        amountSen: BigInt(1500000),
        danaPartnerReferenceNo: null,
        orderId: 'o-c',
        status: EscrowDisbursementStatus.PENDING,
      };
      const [r1, r2] = await Promise.all([(svc as any).settle(row), (svc as any).settle(row)]);

      // Tepat satu transfer ke DANA meskipun dua eksekutor berlomba.
      expect(danaDisbursement.transferToBank).toHaveBeenCalledTimes(1);
      const outcomes = [r1.outcome, r2.outcome].sort();
      expect(outcomes).toEqual(['PENDING', 'RELEASED']);
    });

    it('settle pada baris yang sudah SUCCESS (kalah klaim) → RELEASED tanpa transfer ulang', async () => {
      const { svc, danaDisbursement, seedRow } = buildDeps();
      seedRow({
        id: 'd-s',
        idempotencyKey: 'ORDER:o-s',
        sellerId: 's-1',
        amountSen: BigInt(1500000),
        danaPartnerReferenceNo: 'DSB-X',
        status: EscrowDisbursementStatus.SUCCESS,
        danaReferenceNo: 'DANA-OLD',
      });
      const row = {
        id: 'd-s',
        idempotencyKey: 'ORDER:o-s',
        sellerId: 's-1',
        amountSen: BigInt(1500000),
        danaPartnerReferenceNo: 'DSB-X',
        orderId: 'o-s',
        status: EscrowDisbursementStatus.PENDING, // snapshot basi
      };
      const res = await (svc as any).settle(row);
      expect(res).toEqual({ outcome: 'RELEASED', disbursementId: 'd-s', danaReferenceNo: 'DANA-OLD' });
      expect(danaDisbursement.transferToBank).not.toHaveBeenCalled();
    });
  });

  it('scope MILESTONE/REBATE dipetakan ke enum Prisma', async () => {    const { svc, prisma } = buildDeps();
    (prisma.order.findUnique as jest.Mock).mockResolvedValue({
      id: 'o-6', status: 'COMPLETED', sellerId: 's-1', buyerPayAmount: BigInt(1500000),
    });
    const res = await svc.releaseFunds({
      idempotencyKey: 'MS:ms-1',
      scope: 'MILESTONE' as EscrowDisbursementScope,
      scopeRefId: 'ms-1',
      sellerId: 's-1',
      amountSen: BigInt(500000),
      reason: 'milestone 1',
    });
    expect(res.outcome).toBe('RELEASED');
    expect(prisma.escrowDisbursement.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ scope: 'MILESTONE' }) }),
    );
  });

  describe('reconcileProcessing (E2)', () => {
    const staleRow = (over: Record<string, unknown> = {}) => ({
      id: 'disb-stale',
      idempotencyKey: 'ORDER:o-stale',
      danaPartnerReferenceNo: 'DSB-ORDEROSTALE',
      ...over,
    });

    it('PROCESSING basi + DANA SUCCESS → SUCCESS + releasedAt', async () => {
      const { svc, prisma, danaDisbursement } = buildDeps();
      (prisma.escrowDisbursement.findMany as jest.Mock).mockResolvedValue([staleRow()]);
      (danaDisbursement as any).transferToBankStatus = jest.fn(async () => ({
        partnerReferenceNo: 'DSB-ORDEROSTALE',
        referenceNo: 'DANA-REF-1',
        status: 'SUCCESS',
      }));
      const out = await svc.reconcileProcessing(50);
      expect(out).toEqual({ checked: 1, settled: 1 });
      expect(prisma.escrowDisbursement.update).toHaveBeenCalledWith({
        where: { id: 'disb-stale' },
        data: expect.objectContaining({
          status: EscrowDisbursementStatus.SUCCESS,
          danaReferenceNo: 'DANA-REF-1',
          releasedAt: expect.any(Date),
        }),
      });
    });

    it('PROCESSING basi + DANA FAILED → FAILED (bisa retry via retryDue)', async () => {
      const { svc, prisma, danaDisbursement } = buildDeps();
      (prisma.escrowDisbursement.findMany as jest.Mock).mockResolvedValue([staleRow()]);
      (danaDisbursement as any).transferToBankStatus = jest.fn(async () => ({
        partnerReferenceNo: 'DSB-ORDEROSTALE',
        referenceNo: '',
        status: 'FAILED',
      }));
      const out = await svc.reconcileProcessing(50);
      expect(out).toEqual({ checked: 1, settled: 1 });
      expect(prisma.escrowDisbursement.update).toHaveBeenCalledWith({
        where: { id: 'disb-stale' },
        data: expect.objectContaining({ status: EscrowDisbursementStatus.FAILED }),
      });
    });

    it('query DANA gagal → status DIBIARKAN PROCESSING (tidak ditebak)', async () => {
      const { svc, prisma, danaDisbursement } = buildDeps();
      (prisma.escrowDisbursement.findMany as jest.Mock).mockResolvedValue([staleRow()]);
      (danaDisbursement as any).transferToBankStatus = jest.fn(async () => {
        throw new Error('network timeout');
      });
      const out = await svc.reconcileProcessing(50);
      expect(out).toEqual({ checked: 1, settled: 0 });
      expect(prisma.escrowDisbursement.update).not.toHaveBeenCalled();
    });

    it('hanya polling baris PROCESSING basi (updatedAt > 15 menit)', async () => {
      const { svc, prisma } = buildDeps();
      await svc.reconcileProcessing(50);
      const where = (prisma.escrowDisbursement.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where.status).toBe(EscrowDisbursementStatus.PROCESSING);
      expect(where.danaPartnerReferenceNo).toEqual({ not: null });
      expect(where.updatedAt.lt.getTime()).toBeLessThanOrEqual(Date.now() - 14 * 60 * 1000);
    });
  });
});
