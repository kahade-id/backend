/**
 * Audit Auth 2026-10-10 (#BE-51): rute @Public() hanya bebas CSRF bila request
 * anonim. Bila JwtAuthGuard mengisi request.user dari COOKIE (auth opsional),
 * CSRF tetap wajib — browser melampirkan cookie otomatis.
 */
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { CsrfGuard } from './csrf.guard';

function makeContext(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('CsrfGuard (BE-51)', () => {
  const csrfService = { validateToken: jest.fn() };
  const reflector = { getAllAndOverride: jest.fn() };
  let guard: CsrfGuard;

  beforeEach(() => {
    jest.clearAllMocks();
    guard = new CsrfGuard(csrfService as never, reflector as never);
  });

  it('rute publik + request anonim → lolos tanpa CSRF', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    await expect(
      guard.canActivate(makeContext({ method: 'POST', headers: {}, user: undefined })),
    ).resolves.toBe(true);
    expect(csrfService.validateToken).not.toHaveBeenCalled();
  });

  it('rute publik + user dari cookie tanpa X-CSRF-Token → 403 CSRF_TOKEN_MISSING', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    const err = (await guard
      .canActivate(makeContext({ method: 'POST', headers: {}, user: { sub: 'u1', jti: 'j1' } }))
      .catch(e => e)) as { response?: { code?: string } };
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.response?.code).toBe('CSRF_TOKEN_MISSING');
  });

  it('rute publik + user dari cookie dengan token valid → lolos', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    csrfService.validateToken.mockResolvedValue(true);
    await expect(
      guard.canActivate(
        makeContext({ method: 'POST', headers: { 'x-csrf-token': 'tok' }, user: { sub: 'u1', jti: 'j1' } }),
      ),
    ).resolves.toBe(true);
    expect(csrfService.validateToken).toHaveBeenCalledWith('u1', 'j1', 'tok');
  });

  it('rute publik + Bearer header → lolos (bukan jalur cookie)', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    await expect(
      guard.canActivate(
        makeContext({ method: 'POST', headers: { authorization: 'Bearer abc' }, user: { sub: 'u1', jti: 'j1' } }),
      ),
    ).resolves.toBe(true);
    expect(csrfService.validateToken).not.toHaveBeenCalled();
  });

  it('rute publik + GET dengan user cookie → lolos (bukan metode pengubah state)', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    await expect(
      guard.canActivate(makeContext({ method: 'GET', headers: {}, user: { sub: 'u1', jti: 'j1' } })),
    ).resolves.toBe(true);
  });
});
