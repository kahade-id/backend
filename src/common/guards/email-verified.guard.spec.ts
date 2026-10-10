/**
 * Audit Auth 2026-10-10 (#BE-46): klaim JWT `emailVerified` tidak dipercaya —
 * sumber kebenaran Redis (cache 5 menit) lalu DB.
 */
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { EmailVerifiedGuard } from './email-verified.guard';

function makeContext(user: Record<string, unknown> | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('EmailVerifiedGuard (BE-46)', () => {
  const prisma = { user: { findUnique: jest.fn() } };
  const redis = { get: jest.fn(), set: jest.fn().mockResolvedValue(undefined) };
  let guard: EmailVerifiedGuard;

  beforeEach(() => {
    jest.clearAllMocks();
    guard = new EmailVerifiedGuard(prisma as never, redis as never);
  });

  it('klaim JWT emailVerified=true TIDAK dipercaya bila DB menyatakan belum terverifikasi', async () => {
    redis.get.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({ emailVerified: false });

    await expect(guard.canActivate(makeContext({ sub: 'u1', emailVerified: true }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.user.findUnique).toHaveBeenCalled();
    expect(redis.set).toHaveBeenCalledWith('guard:email_verified:u1', '0', 300);
  });

  it('lolos bila cache Redis menyatakan terverifikasi (tanpa query DB)', async () => {
    redis.get.mockResolvedValue('1');
    await expect(guard.canActivate(makeContext({ sub: 'u1', emailVerified: false }))).resolves.toBe(true);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('lolos bila DB menyatakan terverifikasi', async () => {
    redis.get.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({ emailVerified: true });
    await expect(guard.canActivate(makeContext({ sub: 'u1' }))).resolves.toBe(true);
  });

  it('tanpa user → 403', async () => {
    await expect(guard.canActivate(makeContext(undefined))).rejects.toBeInstanceOf(ForbiddenException);
  });
});
