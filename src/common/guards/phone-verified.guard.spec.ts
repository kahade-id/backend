import { ExecutionContext } from '@nestjs/common';
import { PhoneVerifiedGuard } from './phone-verified.guard';
import * as ErrorCodes from '../constants/error-codes';

function contextFor(user: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as ExecutionContext;
}

describe('PhoneVerifiedGuard', () => {
  const prisma = {
    user: {
      findUnique: jest.fn(),
    },
  };
  const redis = {
    get: jest.fn(),
    set: jest.fn(),
  };
  let guard: PhoneVerifiedGuard;

  beforeEach(() => {
    jest.clearAllMocks();
    guard = new PhoneVerifiedGuard(prisma as never, redis as never);
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
  });

  it('does not trust a phoneVerified claim from a stale JWT after the number has changed', async () => {
    prisma.user.findUnique.mockResolvedValue({ phoneVerified: false });

    await expect(
      guard.canActivate(contextFor({ sub: 'user-1', phoneVerified: true })),
    ).rejects.toMatchObject({
      response: {
        code: ErrorCodes.PHONE_NOT_VERIFIED,
      },
    });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { phoneVerified: true },
    });
  });

  it('allows a user when the positive Redis cache is present', async () => {
    redis.get.mockResolvedValue('1');

    await expect(
      guard.canActivate(contextFor({ sub: 'user-1', phoneVerified: false })),
    ).resolves.toBe(true);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a user when the negative Redis cache is present', async () => {
    redis.get.mockResolvedValue('0');

    await expect(
      guard.canActivate(contextFor({ sub: 'user-1', phoneVerified: false })),
    ).rejects.toMatchObject({
      response: {
        code: ErrorCodes.PHONE_NOT_VERIFIED,
      },
    });
  });

  it('loads phone verification from the database and caches a positive result', async () => {
    prisma.user.findUnique.mockResolvedValue({ phoneVerified: true });

    await expect(
      guard.canActivate(contextFor({ sub: 'user-1', phoneVerified: false })),
    ).resolves.toBe(true);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { phoneVerified: true },
    });
    expect(redis.set).toHaveBeenCalledWith('guard:phone_verified:user-1', '1', 300);
  });

  it('rejects and caches a negative database result', async () => {
    prisma.user.findUnique.mockResolvedValue({ phoneVerified: false });

    await expect(
      guard.canActivate(contextFor({ sub: 'user-1', phoneVerified: false })),
    ).rejects.toMatchObject({
      response: {
        code: ErrorCodes.PHONE_NOT_VERIFIED,
      },
    });
    expect(redis.set).toHaveBeenCalledWith('guard:phone_verified:user-1', '0', 300);
  });
});
