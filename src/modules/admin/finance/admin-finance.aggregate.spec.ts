/**
 * AW-002 (perf-fix): agregat masuk/keluar server-side halaman Keuangan.
 *
 * Menjamin: agregat dihitung dari SEMUA baris yang cocok filter (tanpa clamp
 * limit 100 seperti pola lama), filter yang dipakai SAMA dengan list, dan
 * fail-closed (error validasi dilempar — tidak ada angka tebakan).
 */
import { BadRequestException } from '@nestjs/common';
import { AdminFinanceService, TX_AGGREGATE_SIGN } from './admin-finance.service';

const QUERY = {
  startDate: '2026-09-01',
  endDate: '2026-09-29',
} as const;

function makeService(groupByImpl: () => Promise<unknown[]>, countImpl: () => Promise<number>) {
  const prisma = {
    walletTransaction: {
      groupBy: jest.fn(groupByImpl),
      count: jest.fn(countImpl),
    },
  };
  const service = new AdminFinanceService(
    prisma as never,
    { logAdminAction: jest.fn() } as never,
    {} as never,
    {} as never,
  );
  return { service, prisma };
}

describe('AdminFinanceService.getTransactionsAggregate (AW-002)', () => {
  it('menghitung masuk/keluar dari SEMUA baris yang cocok (tanpa clamp 100)', async () => {
    // Simulasi >100 baris: 150 TOP_UP @Rp10.000 + 60 WITHDRAW @Rp5.000.
    const { service, prisma } = makeService(
      async () => [
        { type: 'TOP_UP', _sum: { amount: 150n * 10_000_00n }, _count: { _all: 150 } },
        { type: 'WITHDRAW', _sum: { amount: 60n * 5_000_00n }, _count: { _all: 60 } },
      ],
      async () => 210,
    );

    const agg = await service.getTransactionsAggregate({ ...QUERY });

    expect(agg.masuk).toBe(150 * 10_000);
    expect(agg.keluar).toBe(60 * 5_000);
    expect(agg.bersih).toBe(150 * 10_000 - 60 * 5_000);
    expect(agg.count).toBe(210);
    // Tidak ada clamp: groupBy dipanggil TANPA take/skip.
    const groupByArg = (prisma.walletTransaction.groupBy as jest.Mock).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(groupByArg).not.toHaveProperty('take');
    expect(groupByArg).not.toHaveProperty('skip');
  });

  it('memakai filter where yang SAMA untuk groupBy dan count (paritas dengan list)', async () => {
    const { service, prisma } = makeService(async () => [], async () => 0);

    await service.getTransactionsAggregate({ ...QUERY, type: 'TOP_UP' as never, q: 'WLT-1' });

    const groupByWhere = (prisma.walletTransaction.groupBy as jest.Mock).mock.calls[0]?.[0]?.where as Record<string, unknown>;
    const countWhere = (prisma.walletTransaction.count as jest.Mock).mock.calls[0]?.[0]?.where as Record<string, unknown>;
    expect(groupByWhere).toEqual(countWhere);
    expect(groupByWhere.type).toBe('TOP_UP');
    expect(groupByWhere.createdAt).toBeDefined();
    expect(groupByWhere.OR).toHaveLength(7);
  });

  it('mengecualikan tipe bertanda netral/tak dikenal dari masuk/keluar tapi tetap dihitung di count', async () => {
    const { service } = makeService(
      async () => [
        { type: 'TOP_UP', _sum: { amount: 1_000_00n }, _count: { _all: 1 } },
        // Tipe tak dikenal (tidak ada di TX_AGGREGATE_SIGN) — paritas perilaku lama.
        { type: 'SOME_FUTURE_TYPE', _sum: { amount: 9_999_00n }, _count: { _all: 3 } },
      ],
      async () => 4,
    );

    const agg = await service.getTransactionsAggregate({ ...QUERY });

    expect(agg.masuk).toBe(1_000);
    expect(agg.keluar).toBe(0);
    expect(agg.count).toBe(4);
  });

  it('FAIL-CLOSED: rentang tanggal invalid melempar (tanpa angka tebakan)', async () => {
    const { service, prisma } = makeService(async () => [], async () => 0);

    await expect(
      service.getTransactionsAggregate({ startDate: '2026-09-29', endDate: '2026-09-01' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.getTransactionsAggregate({ startDate: '2026-06-01', endDate: '2026-09-29' }),
    ).rejects.toBeInstanceOf(BadRequestException); // > 90 hari
    // Validasi gagal SEBELUM query DB apa pun dijalankan.
    expect(prisma.walletTransaction.groupBy).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.count).not.toHaveBeenCalled();
  });

  it('TX_AGGREGATE_SIGN mencakup semua tipe bertanda di TX_META frontend', () => {
    // Paritas kasar: setiap tipe yang dikenal harus punya tanda terdefinisi
    // (bukan undefined) agar tidak ada dana yang hilang diam-diam.
    const knownTypes = [
      'TOP_UP', 'WITHDRAW', 'ORDER_LOCK', 'ORDER_RELEASE', 'ORDER_REFUND',
      'FEE_DEDUCT', 'REFERRAL_REWARD', 'SUBSCRIPTION_PAYMENT', 'ADMIN_CREDIT',
      'ADMIN_DEBIT', 'DISPUTE_RELEASE', 'TRANSFER_SENT', 'TRANSFER_RECEIVED',
      'CAMPAIGN_CASHBACK', 'TOPUP_BONUS',
    ];
    for (const t of knownTypes) {
      expect(TX_AGGREGATE_SIGN[t]).toBeDefined();
    }
    expect(TX_AGGREGATE_SIGN['TOP_UP']).toBe('+');
    expect(TX_AGGREGATE_SIGN['WITHDRAW']).toBe('−');
  });
});
