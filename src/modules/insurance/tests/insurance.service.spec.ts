/**
 * SYS-D-004 — spec untuk InsuranceService (modul insurance sebelumnya 0 test,
 * padahal menyentuh jalur uang: klaim → payout via admin).
 *
 * Cakupan:
 * - Kalkulasi premi/payout: amount di-cap ke INSURANCE_DEFAULT_CAP_IDR
 *   (toSen), claimType dinormalisasi (trim + UPPERCASE).
 * - Guard langganan: klaim hanya untuk subscriber Kahade+ aktif
 *   (INSURANCE_SUBSCRIPTION_REQUIRED).
 * - Guard order: orderId fiktif → ORDER_NOT_FOUND; order milik orang lain →
 *   Forbidden.
 * - Guard status (transisi valid): hanya DRAFT → SUBMITTED; status lain →
 *   INSURANCE_INVALID_STATUS.
 * - Idempotency: submitClaim 2x → tepat 1 transisi status (efek 1x),
 *   pemanggilan kedua ditolak.
 * - listClaims: paginasi + serialisasi amount/cap ke IDR.
 */
import 'reflect-metadata';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { InsuranceClaimStatus } from '@prisma/client';
import { InsuranceService } from '../insurance.service';
import { INSURANCE_DEFAULT_CAP_IDR } from '../../../common/constants/app.constants';
import { toSen } from '../../../common/utils/currency.util';
import * as ErrorCodes from '../../../common/constants/error-codes';

const USER_ID = 'user-uuid-1';
const OTHER_USER_ID = 'user-uuid-2';
const CLAIM_ID = 'claim-uuid-1';

function codeOf(err: unknown): string | undefined {
  if (err && typeof (err as { getResponse?: unknown }).getResponse === 'function') {
    const res = (err as { getResponse: () => unknown }).getResponse();
    if (res && typeof res === 'object') return (res as { code?: string }).code;
  }
  return undefined;
}

type ClaimRow = {
  id: string;
  userId: string;
  orderId: string | null;
  claimType: string;
  amount: bigint;
  cap: bigint;
  status: InsuranceClaimStatus;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const claimRow = (overrides: Partial<ClaimRow> = {}): ClaimRow => ({
  id: CLAIM_ID,
  userId: USER_ID,
  orderId: null,
  claimType: 'DAMAGE',
  amount: toSen(1_000_000),
  cap: toSen(INSURANCE_DEFAULT_CAP_IDR),
  status: InsuranceClaimStatus.DRAFT,
  note: null,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  ...overrides,
});

function makePrismaMock() {
  return {
    insuranceClaim: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    order: {
      findUnique: jest.fn(),
    },
  };
}

function makeService(prisma: ReturnType<typeof makePrismaMock>, isActive = true) {
  const subscriptionsService = { isActive: jest.fn().mockResolvedValue(isActive) };
  const service = new InsuranceService(prisma as never, subscriptionsService as never);
  return { service, subscriptionsService };
}

describe('InsuranceService.createClaim', () => {
  it('menolak klaim bila bukan subscriber aktif (INSURANCE_SUBSCRIPTION_REQUIRED)', async () => {
    const prisma = makePrismaMock();
    const { service, subscriptionsService } = makeService(prisma, false);

    await expect(service.createClaim(USER_ID, { claimType: 'DAMAGE', amount: 100000 }))
      .rejects.toBeInstanceOf(ForbiddenException);
    try {
      await service.createClaim(USER_ID, { claimType: 'DAMAGE', amount: 100000 });
      fail('seharusnya throw');
    } catch (err) {
      expect(codeOf(err)).toBe(ErrorCodes.INSURANCE_SUBSCRIPTION_REQUIRED);
    }
    expect(subscriptionsService.isActive).toHaveBeenCalledWith(USER_ID);
    expect(prisma.insuranceClaim.create).not.toHaveBeenCalled();
  });

  it('menyimpan amount apa adanya bila di bawah cap', async () => {
    const prisma = makePrismaMock();
    prisma.insuranceClaim.create.mockImplementation(async ({ data }: any) => claimRow({
      amount: data.amount, cap: data.cap, claimType: data.claimType, orderId: data.orderId,
    }));
    const { service } = makeService(prisma);

    const res = (await service.createClaim(USER_ID, {
      claimType: 'damage', amount: 2_500_000,
    })) as Record<string, unknown>;

    expect(prisma.insuranceClaim.create).toHaveBeenCalledTimes(1);
    const data = prisma.insuranceClaim.create.mock.calls[0][0].data;
    expect(data.amount).toBe(toSen(2_500_000));
    expect(data.cap).toBe(toSen(INSURANCE_DEFAULT_CAP_IDR));
    expect(data.status).toBe(InsuranceClaimStatus.DRAFT);
    // claimType dinormalisasi: trim + UPPERCASE
    expect(data.claimType).toBe('DAMAGE');
    // serialize: sen → IDR
    expect(res.amount).toBe(2_500_000);
    expect(res.cap).toBe(INSURANCE_DEFAULT_CAP_IDR);
  });

  it('meng-cap amount ke INSURANCE_DEFAULT_CAP_IDR bila melebihi cap', async () => {
    const prisma = makePrismaMock();
    prisma.insuranceClaim.create.mockImplementation(async ({ data }: any) => claimRow({
      amount: data.amount, cap: data.cap,
    }));
    const { service } = makeService(prisma);

    await service.createClaim(USER_ID, { claimType: 'DAMAGE', amount: 99_000_000 });

    const data = prisma.insuranceClaim.create.mock.calls[0][0].data;
    expect(data.amount).toBe(toSen(INSURANCE_DEFAULT_CAP_IDR));
    expect(data.cap).toBe(toSen(INSURANCE_DEFAULT_CAP_IDR));
  });

  it('menolak orderId fiktif (ORDER_NOT_FOUND)', async () => {
    const prisma = makePrismaMock();
    prisma.order.findUnique.mockResolvedValue(null);
    const { service } = makeService(prisma);

    await expect(
      service.createClaim(USER_ID, { claimType: 'DAMAGE', amount: 100000, orderId: 'ORD-20261001-XXXX' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    try {
      await service.createClaim(USER_ID, { claimType: 'DAMAGE', amount: 100000, orderId: 'ORD-20261001-XXXX' });
      fail('seharusnya throw');
    } catch (err) {
      expect(codeOf(err)).toBe(ErrorCodes.ORDER_NOT_FOUND);
    }
    expect(prisma.insuranceClaim.create).not.toHaveBeenCalled();
  });

  it('menolak orderId milik orang lain', async () => {
    const prisma = makePrismaMock();
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1', buyerId: OTHER_USER_ID, sellerId: 'user-uuid-3', status: 'COMPLETED',
    });
    const { service } = makeService(prisma);

    await expect(
      service.createClaim(USER_ID, { claimType: 'DAMAGE', amount: 100000, orderId: 'ORD-20261001-0001' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.insuranceClaim.create).not.toHaveBeenCalled();
  });

  it('menerima orderId milik sendiri (sebagai buyer)', async () => {
    const prisma = makePrismaMock();
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1', buyerId: USER_ID, sellerId: OTHER_USER_ID, status: 'COMPLETED',
    });
    prisma.insuranceClaim.create.mockImplementation(async ({ data }: any) => claimRow({ orderId: data.orderId }));
    const { service } = makeService(prisma);

    const res = (await service.createClaim(USER_ID, {
      claimType: 'DAMAGE', amount: 100000, orderId: '  ORD-20261001-0001 ',
    })) as Record<string, unknown>;

    // orderId di-trim sebelum disimpan
    expect(prisma.insuranceClaim.create.mock.calls[0][0].data.orderId).toBe('ORD-20261001-0001');
    expect(res.orderId).toBe('ORD-20261001-0001');
  });
});

describe('InsuranceService.submitClaim — guard status & idempotency', () => {
  it('DRAFT → SUBMITTED: transisi valid', async () => {
    const prisma = makePrismaMock();
    prisma.insuranceClaim.findFirst.mockResolvedValue(claimRow({ status: InsuranceClaimStatus.DRAFT }));
    prisma.insuranceClaim.update.mockImplementation(async ({ data }: any) =>
      claimRow({ status: data.status }),
    );
    const { service } = makeService(prisma);

    const res = (await service.submitClaim(USER_ID, CLAIM_ID)) as Record<string, unknown>;

    expect(prisma.insuranceClaim.update).toHaveBeenCalledWith({
      where: { id: CLAIM_ID },
      data: { status: InsuranceClaimStatus.SUBMITTED },
    });
    expect(res.status).toBe(InsuranceClaimStatus.SUBMITTED);
  });

  it('submit 2x → tepat 1 efek (pemanggilan kedua ditolak, status tetap SUBMITTED)', async () => {
    const prisma = makePrismaMock();
    // State in-memory: findFirst membaca status terkini.
    let current: ClaimRow = claimRow({ status: InsuranceClaimStatus.DRAFT });
    prisma.insuranceClaim.findFirst.mockImplementation(async () => ({ ...current }));
    prisma.insuranceClaim.update.mockImplementation(async ({ data }: any) => {
      current = { ...current, status: data.status };
      return { ...current };
    });
    const { service } = makeService(prisma);

    await service.submitClaim(USER_ID, CLAIM_ID);
    await expect(service.submitClaim(USER_ID, CLAIM_ID)).rejects.toBeInstanceOf(ForbiddenException);
    try {
      await service.submitClaim(USER_ID, CLAIM_ID);
      fail('seharusnya throw');
    } catch (err) {
      expect(codeOf(err)).toBe(ErrorCodes.INSURANCE_INVALID_STATUS);
    }

    expect(prisma.insuranceClaim.update).toHaveBeenCalledTimes(1);
    expect(current.status).toBe(InsuranceClaimStatus.SUBMITTED);
  });

  it.each([
    InsuranceClaimStatus.SUBMITTED,
    InsuranceClaimStatus.APPROVED,
    InsuranceClaimStatus.PAID,
    InsuranceClaimStatus.REJECTED,
  ])('status %s tidak dapat diajukan ulang', async (status) => {
    const prisma = makePrismaMock();
    prisma.insuranceClaim.findFirst.mockResolvedValue(claimRow({ status }));
    const { service } = makeService(prisma);

    await expect(service.submitClaim(USER_ID, CLAIM_ID)).rejects.toBeInstanceOf(ForbiddenException);
    try {
      await service.submitClaim(USER_ID, CLAIM_ID);
      fail('seharusnya throw');
    } catch (err) {
      expect(codeOf(err)).toBe(ErrorCodes.INSURANCE_INVALID_STATUS);
    }
    expect(prisma.insuranceClaim.update).not.toHaveBeenCalled();
  });

  it('klaim tidak ada / milik orang lain → INSURANCE_CLAIM_NOT_FOUND', async () => {
    const prisma = makePrismaMock();
    prisma.insuranceClaim.findFirst.mockResolvedValue(null);
    const { service } = makeService(prisma);

    await expect(service.submitClaim(USER_ID, CLAIM_ID)).rejects.toBeInstanceOf(NotFoundException);
    try {
      await service.submitClaim(USER_ID, CLAIM_ID);
      fail('seharusnya throw');
    } catch (err) {
      expect(codeOf(err)).toBe(ErrorCodes.INSURANCE_CLAIM_NOT_FOUND);
    }
    // findFirst di-scope ke userId → klaim milik orang lain tak terlihat
    expect(prisma.insuranceClaim.findFirst).toHaveBeenCalledWith({
      where: { id: CLAIM_ID, userId: USER_ID },
    });
  });
});

describe('InsuranceService.listClaims & getClaim', () => {
  it('listClaims: paginasi + serialisasi amount/cap ke IDR', async () => {
    const prisma = makePrismaMock();
    prisma.insuranceClaim.findMany.mockResolvedValue([
      claimRow({ id: 'c1', amount: toSen(500_000) }),
      claimRow({ id: 'c2', amount: toSen(700_000) }),
    ]);
    prisma.insuranceClaim.count.mockResolvedValue(2);
    const { service } = makeService(prisma);

    const res = await service.listClaims(USER_ID, 1, 20);

    expect(prisma.insuranceClaim.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID }, skip: 0, take: 20 }),
    );
    expect(res.data).toHaveLength(2);
    expect((res.data[0] as Record<string, unknown>).amount).toBe(500_000);
    expect((res.data[0] as Record<string, unknown>).cap).toBe(INSURANCE_DEFAULT_CAP_IDR);
    expect(res.total).toBe(2);
    expect(res.page).toBe(1);
  });

  it('getClaim: klaim milik sendiri → serialize; klaim asing → 404', async () => {
    const prisma = makePrismaMock();
    prisma.insuranceClaim.findFirst.mockResolvedValueOnce(claimRow()).mockResolvedValueOnce(null);
    const { service } = makeService(prisma);

    const res = (await service.getClaim(USER_ID, CLAIM_ID)) as Record<string, unknown>;
    expect(res.id).toBe(CLAIM_ID);

    await expect(service.getClaim(USER_ID, 'claim-asing')).rejects.toBeInstanceOf(NotFoundException);
  });
});
