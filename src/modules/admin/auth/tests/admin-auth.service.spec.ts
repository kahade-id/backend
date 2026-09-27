import { UnauthorizedException } from '@nestjs/common';
import { AdminAuthService } from '../admin-auth.service';
import { BadRequestException } from '@nestjs/common';

describe('AdminAuthService refresh account-state enforcement', () => {
  let service: AdminAuthService;
  const prisma = {
    adminUser: { findUnique: jest.fn() },
  };
  const redis = {
    get: jest.fn(),
    setNx: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
  };
  const config = { get: jest.fn().mockReturnValue('7d') };
  const auditLogService = { logAdminAction: jest.fn() };
  const tokenService = {
    verifyAdminRefreshToken: jest.fn(),
    signAdminAccessToken: jest.fn(),
    signAdminRefreshToken: jest.fn(),
  };

  beforeEach(() => {
    jest.resetAllMocks();
    // SEC-502: token mock default membawa anchor umur absolut yang masih segar.
    tokenService.verifyAdminRefreshToken.mockReturnValue({
      sub: 'admin-1',
      jti: 'refresh-jti-1',
      sessionStartedAt: Math.floor(Date.now() / 1000),
    });
    redis.get.mockResolvedValue(null);
    redis.setNx.mockResolvedValue(true);
    redis.del.mockResolvedValue(undefined);
    config.get.mockReturnValue('7d');
    service = new AdminAuthService(
      prisma as never,
      redis as never,
      config as never,
      auditLogService as never,
      tokenService as never,
    );
  });

  it('rejects refresh issued before the admin revocation epoch', async () => {
    tokenService.verifyAdminRefreshToken.mockReturnValue({ sub: 'admin-1', jti: 'refresh-jti-1', iat: 100, sessionStartedAt: Math.floor(Date.now() / 1000) });
    redis.get.mockImplementation(async (key: string) => key === 'admin_revoked:admin-1' ? '101' : null);
    prisma.adminUser.findUnique.mockResolvedValue({
      id: 'admin-1',
      adminId: 'ADM-1',
      email: 'admin@example.com',
      role: 'SUPER_ADMIN',
      isActive: true,
      deletedAt: null,
      lockedUntil: null,
    });

    await expect(service.refreshAdminToken('refresh-token')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tokenService.signAdminAccessToken).not.toHaveBeenCalled();
    expect(tokenService.signAdminRefreshToken).not.toHaveBeenCalled();
    expect(redis.del).toHaveBeenCalledWith('admin_token_rotation:refresh-jti-1');
  });

  it('SEC-502: rotation meneruskan anchor sessionStartedAt (umur absolut tidak di-reset)', async () => {
    const anchor = Math.floor(Date.now() / 1000) - 3600; // sesi dimulai 1 jam lalu
    tokenService.verifyAdminRefreshToken.mockReturnValue({ sub: 'admin-1', jti: 'refresh-jti-1', sessionStartedAt: anchor });
    prisma.adminUser.findUnique.mockResolvedValue({
      id: 'admin-1',
      adminId: 'ADM-1',
      email: 'admin@example.com',
      role: 'SUPER_ADMIN',
      isActive: true,
      deletedAt: null,
      lockedUntil: null,
    });

    const res = await service.refreshAdminToken('refresh-token');

    expect(res).toHaveProperty('accessToken');
    expect(res).toHaveProperty('refreshToken');
    expect(tokenService.signAdminRefreshToken).toHaveBeenCalledWith({ sub: 'admin-1', sessionStartedAt: anchor });
  });

  it('SEC-502: menolak refresh token lama tanpa sessionStartedAt (fail-closed, wajib login ulang)', async () => {
    tokenService.verifyAdminRefreshToken.mockReturnValue({ sub: 'admin-1', jti: 'refresh-jti-1' });

    await expect(service.refreshAdminToken('refresh-token')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tokenService.signAdminAccessToken).not.toHaveBeenCalled();
    expect(tokenService.signAdminRefreshToken).not.toHaveBeenCalled();
  });

  it('SEC-502: menolak refresh token dengan sessionStartedAt invalid', async () => {
    tokenService.verifyAdminRefreshToken.mockReturnValue({
      sub: 'admin-1',
      jti: 'refresh-jti-1',
      sessionStartedAt: 'kemarin',
    });

    await expect(service.refreshAdminToken('refresh-token')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tokenService.signAdminRefreshToken).not.toHaveBeenCalled();
  });

  it.each([24 * 3600, 25 * 3600, 7 * 24 * 3600])(
    'SEC-502: menolak refresh saat umur absolut sesi >= 24 jam (umur=%s detik)',
    async (ageSeconds) => {
      tokenService.verifyAdminRefreshToken.mockReturnValue({
        sub: 'admin-1',
        jti: 'refresh-jti-1',
        sessionStartedAt: Math.floor(Date.now() / 1000) - ageSeconds,
      });

      await expect(service.refreshAdminToken('refresh-token')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(tokenService.signAdminRefreshToken).not.toHaveBeenCalled();
    },
  );

  it('SEC-502: menerima refresh saat umur absolut masih di bawah 24 jam', async () => {
    const anchor = Math.floor(Date.now() / 1000) - (23 * 3600 + 59 * 60); // 23j59m
    tokenService.verifyAdminRefreshToken.mockReturnValue({ sub: 'admin-1', jti: 'refresh-jti-1', sessionStartedAt: anchor });
    prisma.adminUser.findUnique.mockResolvedValue({
      id: 'admin-1',
      adminId: 'ADM-1',
      email: 'admin@example.com',
      role: 'SUPER_ADMIN',
      isActive: true,
      deletedAt: null,
      lockedUntil: null,
    });

    await expect(service.refreshAdminToken('refresh-token')).resolves.toHaveProperty('refreshToken');
  });

  it('rejects refresh while the admin account is locked', async () => {
    prisma.adminUser.findUnique.mockResolvedValue({
      id: 'admin-1',
      adminId: 'ADM-1',
      email: 'admin@example.com',
      role: 'SUPER_ADMIN',
      isActive: true,
      deletedAt: null,
      lockedUntil: new Date(Date.now() + 60_000),
    });

    await expect(service.refreshAdminToken('refresh-token')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tokenService.signAdminAccessToken).not.toHaveBeenCalled();
    expect(tokenService.signAdminRefreshToken).not.toHaveBeenCalled();
    expect(redis.del).toHaveBeenCalledWith('admin_token_rotation:refresh-jti-1');
  });

  it('claims each admin TOTP hash atomically to reject a concurrent replay without blocking the next code', async () => {
    redis.setNx.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect((service as unknown as { claimTotpCode: (id: string, code: string) => Promise<void> }).claimTotpCode('admin-1', '123456')).rejects.toBeInstanceOf(BadRequestException);
    await expect((service as unknown as { claimTotpCode: (id: string, code: string) => Promise<void> }).claimTotpCode('admin-1', '654321')).resolves.toBeUndefined();

    const [firstKey] = redis.setNx.mock.calls[0];
    const [secondKey] = redis.setNx.mock.calls[1];
    expect(firstKey).toMatch(/^totp_used:admin:admin-1:/);
    expect(secondKey).toMatch(/^totp_used:admin:admin-1:/);
    expect(firstKey).not.toBe(secondKey);
    expect(redis.setNx).toHaveBeenCalledWith(firstKey, '1', 90, { throwOnError: true });
    expect(redis.get).not.toHaveBeenCalled();
  });
});
