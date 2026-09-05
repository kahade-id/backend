import { ForbiddenException } from '@nestjs/common';
import { KycRequiredGuard } from './kyc-required.guard';

function createContext(user: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as never;
}

describe('KycRequiredGuard', () => {
  it('does not trust an APPROVED status copied into a stale access token', async () => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ kycStatus: 'REJECTED' }),
      },
    };
    const redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };
    const guard = new KycRequiredGuard(prisma as never, redis as never);

    await expect(
      guard.canActivate(createContext({ sub: 'user-1', kycStatus: 'APPROVED' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { kycStatus: true },
    });
  });

  it('allows an account approved by the current database status', async () => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ kycStatus: 'APPROVED' }),
      },
    };
    const redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };
    const guard = new KycRequiredGuard(prisma as never, redis as never);

    await expect(
      guard.canActivate(createContext({ sub: 'user-1', kycStatus: 'PENDING' })),
    ).resolves.toBe(true);
  });
});
