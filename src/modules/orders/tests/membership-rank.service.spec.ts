import { MembershipRank, Prisma } from '@prisma/client';
import { MembershipRankService } from '../membership-rank.service';

/*
 * C-22 regression: `checkAndUpdateMembershipRank` runs on the CALLER's `tx`, at the tail of a
 * Serializable transaction that has already released escrow (`order-state.service.ts:562`,
 * `admin-orders.service.ts:343`, `auto-complete-orders.service.ts:332`). It used to catch every
 * error. A DB error there has already aborted the PG transaction, so swallowing it protected
 * nothing — and it hid the retryable serialization failures that the caller's retry loop
 * (`isRetryableDbError`: P2034 / 40001 / 40P01 / deadlock) exists to catch, turning a conflict
 * that would have succeeded on retry into a failed order completion.
 */

const USER_ROW = {
  membershipRank: MembershipRank.BRONZE,
  totalOrdersCompleted: 20,
  totalTransactionValue: 5_000_000n,
  createdAt: new Date('2025-01-01T00:00:00Z'),
};

function makeTx(overrides: Record<string, unknown> = {}) {
  return {
    user: {
      findUnique: jest.fn().mockResolvedValue(USER_ROW),
      update: jest.fn().mockResolvedValue({}),
    },
    rating: { aggregate: jest.fn().mockResolvedValue({ _avg: { stars: 4.5 } }) },
    membershipRankHistory: { create: jest.fn().mockResolvedValue({}) },
    ...overrides,
  } as unknown as Prisma.TransactionClient;
}

const serializationFailure = () =>
  new Prisma.PrismaClientUnknownRequestError(
    'could not serialize access due to read/write dependencies among transactions (SQLSTATE 40001)',
    { clientVersion: 'test' },
  );

describe('MembershipRankService — C-22 DB errors must reach the caller', () => {
  let service: MembershipRankService;

  beforeEach(() => {
    service = new MembershipRankService();
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  });

  it('ranks a user up on the happy path', async () => {
    const tx = makeTx();
    await service.checkAndUpdateMembershipRank(tx, 'user-1');
    expect(tx.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ membershipRank: MembershipRank.SILVER }) }),
    );
    expect(tx.membershipRankHistory.create).toHaveBeenCalled();
  });

  it('RETHROWS a serialization failure so the caller retry loop can see it', async () => {
    const tx = makeTx({
      user: { findUnique: jest.fn().mockResolvedValue(USER_ROW), update: jest.fn().mockRejectedValue(serializationFailure()) },
    });
    await expect(service.checkAndUpdateMembershipRank(tx, 'user-1')).rejects.toBeInstanceOf(
      Prisma.PrismaClientUnknownRequestError,
    );
  });

  it('rethrown serialization failure still matches the callers isRetryableDbError predicate', async () => {
    const tx = makeTx({
      user: { findUnique: jest.fn().mockResolvedValue(USER_ROW), update: jest.fn().mockRejectedValue(serializationFailure()) },
    });
    const err = await service.checkAndUpdateMembershipRank(tx, 'user-1').catch((e: unknown) => e);
    // Mirrors `order-state.service.ts:582` exactly.
    const isRetryable =
      err instanceof Prisma.PrismaClientUnknownRequestError &&
      ['40001', 'serialization', '40p01', 'deadlock'].some((m) => err.message.toLowerCase().includes(m));
    expect(isRetryable).toBe(true);
  });

  it('RETHROWS a known request error (P2034 write conflict)', async () => {
    const tx = makeTx({
      membershipRankHistory: {
        create: jest.fn().mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError('write conflict', { code: 'P2034', clientVersion: 'test' }),
        ),
      },
    });
    await expect(service.checkAndUpdateMembershipRank(tx, 'user-1')).rejects.toMatchObject({ code: 'P2034' });
  });

  it('RETHROWS a DB error raised by the rank-history write, not just the rank write', async () => {
    const tx = makeTx({
      membershipRankHistory: { create: jest.fn().mockRejectedValue(serializationFailure()) },
    });
    await expect(service.checkAndUpdateMembershipRank(tx, 'user-1')).rejects.toBeInstanceOf(
      Prisma.PrismaClientUnknownRequestError,
    );
  });

  it('still swallows a plain JS fault, which leaves the transaction healthy', async () => {
    // A null `createdAt` throws a TypeError before any statement is sent, so the caller's
    // transaction is untouched and the original best-effort intent still applies.
    const tx = makeTx({
      user: {
        findUnique: jest.fn().mockResolvedValue({ ...USER_ROW, createdAt: null }),
        update: jest.fn().mockResolvedValue({}),
      },
    });
    await expect(service.checkAndUpdateMembershipRank(tx, 'user-1')).resolves.toBeUndefined();
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('is a no-op when the user is missing', async () => {
    const tx = makeTx({ user: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() } });
    await expect(service.checkAndUpdateMembershipRank(tx, 'ghost')).resolves.toBeUndefined();
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('does not write when the computed rank is not higher than the current one', async () => {
    const tx = makeTx({
      user: {
        findUnique: jest.fn().mockResolvedValue({ ...USER_ROW, membershipRank: MembershipRank.DIAMOND }),
        update: jest.fn(),
      },
    });
    await service.checkAndUpdateMembershipRank(tx, 'user-1');
    expect(tx.user.update).not.toHaveBeenCalled();
  });
});
