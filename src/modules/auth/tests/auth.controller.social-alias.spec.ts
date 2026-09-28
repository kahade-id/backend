/**
 * auth.controller.social-alias.spec.ts — Wave 2 integritas-139:
 * aplikasi mobile memanggil POST /v1/auth/social/login sedangkan route kanonis
 * adalah POST /v1/auth/social-login. Alias harus terdaftar dan berbagi handler
 * yang sama persis (throttle/cookie/2FA behavior identik).
 */
import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { AuthController } from '../auth.controller';

function registeredRoutes(): Array<{ method: RequestMethod; path: string }> {
  const proto = AuthController.prototype as unknown as Record<string, (...args: never[]) => unknown>;
  const out: Array<{ method: RequestMethod; path: string }> = [];
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    const path: string | string[] | undefined = Reflect.getMetadata(PATH_METADATA, proto[name]);
    const method: RequestMethod | undefined = Reflect.getMetadata(METHOD_METADATA, proto[name]);
    if (path === undefined || method === undefined) continue;
    for (const p of Array.isArray(path) ? path : [path]) out.push({ method, path: p });
  }
  return out;
}

describe('AuthController social-login alias (integritas-139)', () => {
  it('mendaftarkan POST social-login DAN POST social/login', () => {
    const routes = registeredRoutes().filter((r) => r.method === RequestMethod.POST);
    const paths = routes.map((r) => r.path);
    expect(paths).toContain('social-login');
    expect(paths).toContain('social/login');
  });

  it('alias mendelegasikan ke handler yang sama dengan route kanonis', async () => {
    type AliasHarness = {
      handleSocialLogin: jest.Mock;
      socialLogin: (...a: never[]) => Promise<unknown>;
      socialLoginAlias: (...a: never[]) => Promise<unknown>;
    };
    const controller = Object.create(AuthController.prototype) as AliasHarness;
    const spy = jest.fn().mockResolvedValue({ ok: true });
    controller.handleSocialLogin = spy as never;

    const dto = { provider: 'google', idToken: 'tok' } as never;
    const req = { ip: '127.0.0.1', headers: {} } as never;
    const res = {} as never;

    await expect(controller.socialLogin(dto, req, res)).resolves.toEqual({ ok: true });
    await expect(controller.socialLoginAlias(dto, req, res)).resolves.toEqual({ ok: true });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(1, dto, req, res);
    expect(spy).toHaveBeenNthCalledWith(2, dto, req, res);
  });
});
