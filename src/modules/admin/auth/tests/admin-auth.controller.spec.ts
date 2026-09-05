import { UnauthorizedException } from '@nestjs/common';
import { AdminAuthController } from '../admin-auth.controller';

describe('AdminAuthController refresh cookie lifecycle', () => {
  const configService = { get: jest.fn().mockReturnValue('v1') };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('clears a stale admin refresh cookie when token rotation is rejected', async () => {
    const adminAuthService = {
      refreshAdminToken: jest.fn().mockRejectedValue(new UnauthorizedException('revoked')),
    };
    const controller = new AdminAuthController(adminAuthService as never, configService as never);
    const res = { cookie: jest.fn(), clearCookie: jest.fn() };

    await expect(controller.refreshToken({ cookies: { kahade_admin_refresh: 'stale-token' } } as never, res as never)).rejects.toThrow(UnauthorizedException);

    expect(res.clearCookie).toHaveBeenCalledWith('kahade_admin_refresh', { path: '/v1/admin/auth' });
  });

  it('clears the admin refresh cookie when a refresh request carries no token', async () => {
    const adminAuthService = { refreshAdminToken: jest.fn() };
    const controller = new AdminAuthController(adminAuthService as never, configService as never);
    const res = { cookie: jest.fn(), clearCookie: jest.fn() };

    await expect(controller.refreshToken({ cookies: {} } as never, res as never)).rejects.toThrow(UnauthorizedException);

    expect(res.clearCookie).toHaveBeenCalledWith('kahade_admin_refresh', { path: '/v1/admin/auth' });
    expect(adminAuthService.refreshAdminToken).not.toHaveBeenCalled();
  });
});
