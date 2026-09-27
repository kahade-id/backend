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
    prisma.adminUser.findUnique.mockResolvedValue({
      isActive: true,
      deletedAt: null,
      lockedUntil: null,
    });

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request.admin).toMatchObject({ sub: 'admin-1', jti: 'admin-jti-1' });
  });

  it('rejects a verified admin token without a JTI claim', async () => {
    verifyAsync.mockResolvedValue({ sub: 'admin-1' });

    await expect(guard.canActivate(createContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(redis.get).not.toHaveBeenCalled();
    expect(prisma.adminUser.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a token issued before the admin revocation epoch', async () => {
    verifyAsync.mockResolvedValue({ sub: 'admin-1', jti: 'admin-jti-1', iat: 100 });
    redis.get.mockImplementation(async (key: string) =>
      key === 'admin_revoked:admin-1' ? '101' : null,
    );
    prisma.adminUser.findUnique.mockResolvedValue({
      isActive: true,
      deletedAt: null,
      lockedUntil: null,
    });

    await expect(guard.canActivate(createContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.adminUser.findUnique).not.toHaveBeenCalled();
  });

  it('allows a token issued after the admin revocation epoch', async () => {
    verifyAsync.mockResolvedValue({ sub: 'admin-1', jti: 'admin-jti-1', iat: 102 });
    redis.get.mockImplementation(async (key: string) =>
      key === 'admin_revoked:admin-1' ? '101' : null,
    );
    prisma.adminUser.findUnique.mockResolvedValue({
      isActive: true,
      deletedAt: null,
      lockedUntil: null,
    });

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request.admin).toMatchObject({ sub: 'admin-1', jti: 'admin-jti-1', iat: 102 });
  });

  it('rejects a valid token while the admin account is locked', async () => {
    prisma.adminUser.findUnique.mockResolvedValue({
      isActive: true,
      deletedAt: null,
      lockedUntil: new Date(Date.now() + 60_000),
    });

    await expect(guard.canActivate(createContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(request.admin).toBeUndefined();
  });
});

describe('JwtAdminGuard emergency-grant scope enforcement (ADM-402/ADM-418)', () => {
  let guard: JwtAdminGuard;
  let verifyAsync: jest.Mock;
  let redis: { get: jest.Mock };
  let prisma: { adminUser: { findUnique: jest.Mock } };

  function makeRequest(url: string) {
    return { headers: { authorization: 'Bearer <redacted>' }, url, originalUrl: url };
  }

  beforeEach(() => {
    verifyAsync = jest.fn();
    redis = { get: jest.fn().mockResolvedValue(null) };
    prisma = { adminUser: { findUnique: jest.fn() } };
    const config = { get: jest.fn().mockReturnValue('admin-secret') };
    guard = new JwtAdminGuard(
      { verifyAsync } as never,
      redis as never,
      config as never,
      prisma as never,
    );
    prisma.adminUser.findUnique.mockResolvedValue({
      isActive: true,
      deletedAt: null,
      lockedUntil: null,
    });
  });

  function scopedToken(scope: string) {
    verifyAsync.mockResolvedValue({ sub: 'admin-1', jti: 'admin-jti-1', scope });
  }

  it('allows a USERS-scoped token on /v1/admin/users paths', async () => {
    scopedToken('USERS');
    const request = makeRequest('/v1/admin/users?page=1');
    await expect(guard.canActivate({ switchToHttp: () => ({ getRequest: () => request }) } as never)).resolves.toBe(true);
  });

  it('allows a USERS-scoped token on child paths', async () => {
    scopedToken('USERS');
    const request = makeRequest('/v1/admin/users/abc123');
    await expect(guard.canActivate({ switchToHttp: () => ({ getRequest: () => request }) } as never)).resolves.toBe(true);
  });

  it('rejects a USERS-scoped token on /v1/admin/finance paths (403)', async () => {
    scopedToken('USERS');
    const request = makeRequest('/v1/admin/finance/withdrawals');
    await expect(guard.canActivate({ switchToHttp: () => ({ getRequest: () => request }) } as never)).rejects.toMatchObject({
      name: 'ForbiddenException',
    });
  });

  it('rejects a token with an unknown scope everywhere (fail-closed, 403)', async () => {
    scopedToken('SUPERPOWERS');
    const request = makeRequest('/v1/admin/users');
    await expect(guard.canActivate({ switchToHttp: () => ({ getRequest: () => request }) } as never)).rejects.toMatchObject({
      name: 'ForbiddenException',
    });
  });

  it('rejects a token with a legacy dead scope (mfa_setup) — fail-closed', async () => {
    scopedToken('mfa_setup');
    const request = makeRequest('/v1/admin/users');
    await expect(guard.canActivate({ switchToHttp: () => ({ getRequest: () => request }) } as never)).rejects.toMatchObject({
      name: 'ForbiddenException',
    });
  });

  it('allows an ALL-scoped token on any path (role guard still applies downstream)', async () => {
    scopedToken('ALL');
    const request = makeRequest('/v1/admin/finance/withdrawals');
    await expect(guard.canActivate({ switchToHttp: () => ({ getRequest: () => request }) } as never)).resolves.toBe(true);
  });

  it('allows a token without scope claim on any path', async () => {
    verifyAsync.mockResolvedValue({ sub: 'admin-1', jti: 'admin-jti-1' });
    const request = makeRequest('/v1/admin/finance/withdrawals');
    await expect(guard.canActivate({ switchToHttp: () => ({ getRequest: () => request }) } as never)).resolves.toBe(true);
  });

  it('rejects a KYC-scoped token on a lookalike path that only shares a string prefix', async () => {
    // /admin/kyc2 bukan child dari /admin/kyc — harus ditolak.
    scopedToken('KYC');
    const request = makeRequest('/v1/admin/kyc2');
    await expect(guard.canActivate({ switchToHttp: () => ({ getRequest: () => request }) } as never)).rejects.toMatchObject({
      name: 'ForbiddenException',
    });
  });
});
