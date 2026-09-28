/**
 * AW-005 (perf-fix): metrik KYC dihitung di SQL via percentile_cont.
 *
 * Menjamin: getKycMetrics TIDAK lagi menarik hingga 5000 baris kycRequest ke
 * memori Node untuk menghitung median/p50/p95 di JS — agregat dihitung di
 * database, dan hasil dipetakan dengan benar (count bigint → number,
 * pembulatan 2 desimal). Validasi periode tetap fail-closed.
 */
import { BadRequestException } from '@nestjs/common';
import { AdminKycService } from '../admin-kyc.service';

function makeService() {
  const prisma = {
    $queryRaw: jest.fn(),
    operationalSlaConfig: { findUnique: jest.fn() },
    kycRequest: { findMany: jest.fn() },
  };
  const service = new AdminKycService(
    prisma as never,
    {} as never,
    { logAdminAction: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, prisma };
}

describe('AdminKycService.getKycMetrics (AW-005)', () => {
  it('menghitung p50/p95 di SQL via percentile_cont — tanpa findMany 5000 baris', async () => {
    const { service, prisma } = makeService();
    prisma.operationalSlaConfig.findUnique.mockResolvedValue({ slaHours: 48, useBusinessHours: false });
    prisma.kycRequest.findMany.mockResolvedValue([]); // snapshot antrean kosong
    prisma.$queryRaw.mockResolvedValue([
      { status: 'APPROVED', count: 120n, p50: 10.5, p95: 40.25, avg: 12.345, min: 0.5, max: 90.0 },
    ]);

    const res = await service.getKycMetrics('2026-09-01', '2026-09-29');

    // Agregat review-time HARUS dari $queryRaw (SQL), bukan findMany.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = String(prisma.$queryRaw.mock.calls[0][0]);
    expect(sql).toMatch(/percentile_cont\(0\.5\)/);
    expect(sql).toMatch(/percentile_cont\(0\.95\)/);
    expect(sql).not.toMatch(/LIMIT 5000/i);

    const approved = (res.reviewTimeHours as Record<string, Record<string, number>>).APPROVED;
    expect(approved.count).toBe(120); // bigint → number
    expect(approved.p50).toBe(10.5);
    expect(approved.p95).toBe(40.25);
    expect(approved.avg).toBe(12.35); // round2
    expect(approved.min).toBe(0.5);
    expect(approved.max).toBe(90);
  });

  it('FAIL-CLOSED: periode invalid melempar sebelum query apa pun', async () => {
    const { service, prisma } = makeService();

    await expect(
      service.getKycMetrics('2026-09-29', '2026-09-01'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.kycRequest.findMany).not.toHaveBeenCalled();
  });
});
