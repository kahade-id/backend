import { UnauthorizedException } from '@nestjs/common';
import { JwtAdminGuard } from './jwt-admin.guard';

function createContext(request: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as never;
}

describe('JwtAdminGuard account-state enforcement', () => {
  let guard: JwtAdminGuard;
  let verifyAsync: jest.Mock;
  let redis: { get: jest.Mock };
  let prisma: { adminUser: { findUnique: jest.Mock } };
  let request: Record<string, unknown>;

  beforeEach(() => {
    request = { headers: { authorization: 'Bearer admin-access-token' }, url: '/v1/admin/profile' };
    verifyAsync = jest.fn().mockResolvedValue({ sub: 'admin-1', jti: 'admin-jti-1' });
    redis = { get: jest.fn().mockResolvedValue(null) };
    prisma = { adminUser: { findUnique: jest.fn() } };
    const config = { get: jest.fn().mockReturnValue('admin-secret') };
    guard = new JwtAdminGuard(
      { verifyAsync } as never,
      redis as never,
      config as never,
      prisma as never,
    );
  });

  it('allows an active, unlocked admin account', async () => {
    prisma.adminUser.findUnique.mockResolvedValue({ isActive: true, deletedAt: null, lockedUntil: null });

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request.admin).toMatchObject({ sub: 'admin-1', jti: 'admin-jti-1' });
  });

  it('rejects a verified admin token without a JTI claim', async () => {
    verifyAsync.mockResolvedValue({ sub: 'admin-1' });

    await expect(guard.canActivate(createContext(request))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(redis.get).not.toHaveBeenCalled();
    expect(prisma.adminUser.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a token issued before the admin revocation epoch', async () => {
    verifyAsync.mockResolvedValue({ sub: 'admin-1', jti: 'admin-jti-1', iat: 100 });
    redis.get.mockImplementation(async (key: string) => key === 'admin_revoked:admin-1' ? '101' : null);
    prisma.adminUser.findUnique.mockResolvedValue({ isActive: true, deletedAt: null, lockedUntil: null });

    await expect(guard.canActivate(createContext(request))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.adminUser.findUnique).not.toHaveBeenCalled();
  });

  it('allows a token issued after the admin revocation epoch', async () => {
    verifyAsync.mockResolvedValue({ sub: 'admin-1', jti: 'admin-jti-1', iat: 102 });
    redis.get.mockImplementation(async (key: string) => key === 'admin_revoked:admin-1' ? '101' : null);
    prisma.adminUser.findUnique.mockResolvedValue({ isActive: true, deletedAt: null, lockedUntil: null });

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request.admin).toMatchObject({ sub: 'admin-1', jti: 'admin-jti-1', iat: 102 });
  });

  it('rejects a valid token while the admin account is locked', async () => {
    prisma.adminUser.findUnique.mockResolvedValue({
      isActive: true,
      deletedAt: null,
      lockedUntil: new Date(Date.now() + 60_000),
    });

    await expect(guard.canActivate(createContext(request))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(request.admin).toBeUndefined();
  });
});
