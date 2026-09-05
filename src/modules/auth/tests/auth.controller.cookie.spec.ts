import { UnauthorizedException } from '@nestjs/common';
import { AuthController } from '../auth.controller';

type CookieResponse = { cookie: jest.Mock; clearCookie: jest.Mock };
type CookieController = {
  setAccessTokenCookie: (res: CookieResponse, token: string) => void;
  setRefreshTokenCookie: (res: CookieResponse, token: string) => void;
  refreshToken: (req: { cookies?: Record<string, string> }, body: { refreshToken?: string }, res: CookieResponse) => Promise<unknown>;
};

function makeController(nodeEnv: string, appUrl: string): CookieController {
  const controller = Object.create(AuthController.prototype) as CookieController;
  (controller as unknown as { configService: { get: jest.Mock } }).configService = {
    get: jest.fn((key: string) => {
      if (key === 'app.nodeEnv') return nodeEnv;
      if (key === 'app.appUrl') return appUrl;
      if (key === 'app.apiPrefix') return 'v1';
      return undefined;
    }),
  };
  return controller;
}

describe('AuthController cookie security policy', () => {
  it('allows non-Secure cookies only for localhost HTTP development/test', () => {
    const controller = makeController('development', 'http://localhost:3000');
    const response: CookieResponse = { cookie: jest.fn(), clearCookie: jest.fn() };

    controller.setAccessTokenCookie(response, 'access-token');
    controller.setRefreshTokenCookie(response, 'refresh-token');

    expect(response.cookie).toHaveBeenNthCalledWith(1, 'kahade_access_token', 'access-token', expect.objectContaining({ secure: false }));
    expect(response.cookie).toHaveBeenNthCalledWith(2, 'kahade_refresh_token', 'refresh-token', expect.objectContaining({ secure: false, path: '/v1/auth/refresh' }));
  });

  it('keeps cookies Secure for production and non-local HTTP URLs', () => {
    const production = makeController('production', 'https://app.kahade.id');
    const staging = makeController('staging', 'http://staging.kahade.id');
    const productionResponse: CookieResponse = { cookie: jest.fn(), clearCookie: jest.fn() };
    const stagingResponse: CookieResponse = { cookie: jest.fn(), clearCookie: jest.fn() };

    production.setAccessTokenCookie(productionResponse, 'access-token');
    staging.setRefreshTokenCookie(stagingResponse, 'refresh-token');

    expect(productionResponse.cookie).toHaveBeenCalledWith('kahade_access_token', 'access-token', expect.objectContaining({ secure: true }));
    expect(stagingResponse.cookie).toHaveBeenCalledWith('kahade_refresh_token', 'refresh-token', expect.objectContaining({ secure: true }));
  });

  it('clears stale browser cookies when refresh is rejected', async () => {
    const controller = makeController('production', 'https://app.kahade.id');
    const authService = { refreshToken: jest.fn().mockRejectedValue(new UnauthorizedException('Invalid refresh token')) };
    (controller as unknown as { authService: typeof authService }).authService = authService;
    const response: CookieResponse = { cookie: jest.fn(), clearCookie: jest.fn() };

    await expect(controller.refreshToken({ cookies: { kahade_refresh_token: 'revoked-token' } }, {}, response)).rejects.toBeInstanceOf(UnauthorizedException);

    expect(response.clearCookie).toHaveBeenNthCalledWith(1, 'kahade_access_token', { path: '/' });
    expect(response.clearCookie).toHaveBeenNthCalledWith(2, 'kahade_refresh_token', { path: '/v1/auth/refresh' });
  });

  it('clears stale browser cookies when neither a cookie nor body refresh token is supplied', async () => {
    const controller = makeController('production', 'https://app.kahade.id');
    const response: CookieResponse = { cookie: jest.fn(), clearCookie: jest.fn() };

    await expect(controller.refreshToken({}, {}, response)).rejects.toBeInstanceOf(UnauthorizedException);

    expect(response.clearCookie).toHaveBeenCalledTimes(2);
  });
});
