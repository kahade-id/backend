/**
 * SEC-501: bootstrap bypass MFA admin dihapus — admin pertama TANPA MFA
 * tidak lagi memperoleh sesi penuh; ia diarahkan ke enrollment aman
 * (requiresMfaSetup + tempToken → /mfa/setup + /mfa/enable).
 */
import { AdminAuthService } from '../admin-auth.service';

jest.mock('../../../../common/utils/crypto.util', () => ({
  bcryptCompare: jest.fn(async () => true),
  decryptAES: jest.fn(async (v: string) => v),
  encryptAES: jest.fn(async (v: string) => v),
  sha256: jest.fn((v: string) => v),
}));

describe('AdminAuthService SEC-501 — MFA enforcement tanpa bootstrap bypass', () => {
  const prisma = {
    adminUser: {
      findUnique: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    systemConfig: { findUnique: jest.fn() },
  };
  const redis = {
    get: jest.fn(),
    setNx: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
    incrWithTtl: jest.fn(),
  };
  const config = { get: jest.fn() };
  const auditLogService = { logAdminAction: jest.fn() };
  const tokenService = {
    signTempToken: jest.fn(() => 'temp-token-xyz'),
    signAdminAccessToken: jest.fn(() => 'access-token'),
    signAdminRefreshToken: jest.fn(() => 'refresh-token'),
    verifyAdminRefreshToken: jest.fn(),
    verifyTempToken: jest.fn(),
  };

  let service: AdminAuthService;

  const activeAdmin = (overrides = {}) => ({
    id: 'admin-1',
    adminId: 'ADM-001',
    email: 'admin@example.com',
    password: 'hashed',
    role: 'SUPER_ADMIN',
    isActive: true,
    isMfaEnabled: false,
    mfaSecret: null,
    deletedAt: null,
    lockedUntil: null,
    failedLoginAttempts: 0,
    lastLoginAt: null,
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // admin_mfa_required=true (default fail-closed).
    prisma.systemConfig.findUnique.mockResolvedValue({ key: 'admin_mfa_required', value: 'true' });
    prisma.adminUser.update.mockResolvedValue({ failedLoginAttempts: 0 });
    service = new AdminAuthService(
      prisma as never,
      redis as never,
      config as never,
      auditLogService as never,
      tokenService as never,
    );
  });

  it('admin PERTAMA tanpa MFA diarahkan ke enrollment, bukan diberi sesi penuh', async () => {
    // TIDAK ADA admin dengan MFA aktif di seluruh sistem (mfaCount = 0).
    prisma.adminUser.count.mockResolvedValue(0);
    prisma.adminUser.findUnique.mockResolvedValue(activeAdmin());

    const res = await service.login('admin@example.com', 'password-benar');

    // Tidak ada sesi penuh — hanya jalur enrollment.
    expect(res).toEqual({ requiresMfaSetup: true, tempToken: 'temp-token-xyz' });
    expect(tokenService.signTempToken).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'admin-1', scope: 'admin_mfa_setup' }),
    );
    expect(tokenService.signAdminAccessToken).not.toHaveBeenCalled();
    expect(tokenService.signAdminRefreshToken).not.toHaveBeenCalled();
  });

  it('tetap mengarahkan ke enrollment meski belum ada satupun admin MFA (tanpa bypass)', async () => {
    prisma.adminUser.count.mockResolvedValue(0);
    prisma.adminUser.findUnique.mockResolvedValue(activeAdmin({ isMfaEnabled: false }));

    const res = await service.login('admin@example.com', 'password-benar');

    expect(res).toMatchObject({ requiresMfaSetup: true });
    expect('accessToken' in res).toBe(false);
  });

  it('admin dengan MFA aktif tetap melewati jalur 2FA normal (requiresMfa)', async () => {
    prisma.adminUser.count.mockResolvedValue(1);
    prisma.adminUser.findUnique.mockResolvedValue(activeAdmin({ isMfaEnabled: true, mfaSecret: 'enc-secret' }));

    const res = await service.login('admin@example.com', 'password-benar');

    expect(res).toEqual({ requiresMfa: true, tempToken: 'temp-token-xyz' });
    expect(tokenService.signTempToken).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'admin_2fa_verify' }),
    );
  });

  it('bila admin_mfa_required=false eksplisit, login tanpa MFA tetap diberi sesi (opt-out sadar)', async () => {
    prisma.systemConfig.findUnique.mockResolvedValue({ key: 'admin_mfa_required', value: 'false' });
    prisma.adminUser.findUnique.mockResolvedValue(activeAdmin());
    (service as any).recordAdminSession = jest.fn().mockResolvedValue(undefined);

    const res = await service.login('admin@example.com', 'password-benar');

    expect(res).toMatchObject({ accessToken: 'access-token', refreshToken: 'refresh-token' });
  });
});
