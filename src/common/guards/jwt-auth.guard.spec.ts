import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';

function createContext(request: Record<string, unknown>) {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => request }),
  } as never;
}

describe('JwtAuthGuard database authorization defense-in-depth', () => {
  let guard: JwtAuthGuard;
  let request: Record<string, unknown>;
  let prisma: {
    userSession: { findUnique: jest.Mock };
    user: { findUnique: jest.Mock };
  };
  let redis: {
    get: jest.Mock;
    getClient: jest.Mock;
    getPrefix: jest.Mock;
  };
  let verifyAsync: jest.Mock;

  beforeEach(() => {
    request = { headers: { authorization: 'Bearer access-token' } };
    prisma = {
      userSession: { findUnique: jest.fn() },
      user: { findUnique: jest.fn() },
    };
    const redisClient = {
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(1),
      pipeline: jest.fn(() => ({
        incr: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        expire: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      })),
    };
    redis = {
      get: jest.fn().mockResolvedValue(null),
      getClient: jest.fn(() => redisClient),
      getPrefix: jest.fn(() => 'kahade:'),
    };
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
    verifyAsync = jest.fn().mockResolvedValue({
      sub: 'user-1',
      sessionId: 'session-1',
      jti: 'jti-1',
    });
    const jwtService = { verifyAsync };
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'jwt.secret') return 'test-secret';
        if (key === 'app.redisAuthFailOpen') return false;
        return undefined;
      }),
    };
    guard = new JwtAuthGuard(
      reflector as never,
      jwtService as never,
      null,
      redis as never,
      config as never,
      prisma as never,
    );
  });

  it('allows an active session whose database owner is active', async () => {
    prisma.userSession.findUnique.mockResolvedValue({
      userId: 'user-1',
      isRevoked: false,
      expiresAt: new Date(Date.now() + 60_000),
      user: { isActive: true, isBanned: false, deletedAt: null },
    });

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request.user).toMatchObject({ sub: 'user-1', sessionId: 'session-1' });
  });

  it('rejects a verified token without a sessionId claim', async () => {
    verifyAsync.mockResolvedValue({ sub: 'user-1', jti: 'jti-legacy' });

    await expect(guard.canActivate(createContext(request))).rejects.toMatchObject({
      response: { code: 'UNAUTHORIZED' },
    });
    expect(prisma.userSession.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a session revoked in the database even when Redis has no blacklist key', async () => {
    prisma.userSession.findUnique.mockResolvedValue({
      userId: 'user-1',
      isRevoked: true,
      expiresAt: new Date(Date.now() + 60_000),
      user: { isActive: true, isBanned: false, deletedAt: null },
    });

    await expect(guard.canActivate(createContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an active session owned by a banned account', async () => {
    prisma.userSession.findUnique.mockResolvedValue({
      userId: 'user-1',
      isRevoked: false,
      expiresAt: new Date(Date.now() + 60_000),
      user: { isActive: true, isBanned: true, deletedAt: null },
    });

    await expect(guard.canActivate(createContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('fails closed when the database authorization check is unavailable', async () => {
    prisma.userSession.findUnique.mockRejectedValue(new Error('database unavailable'));

    await expect(guard.canActivate(createContext(request))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

// ============================================================
// Section 6 — optional auth pada rute @Public()
// ============================================================
// Sebelum perubahan ini canActivate() langsung `return true` untuk rute publik,
// jadi request.user tidak pernah terisi dan SEMUA gate berbasis viewer mati
// tanpa suara: block-list di getPublicProfile / getUserRatings / Q&A / showcase
// feed / deep-link share, plus isFollowing, isFavoritedByViewer, dan
// isUpvotedByViewer. User yang diblokir tetap bisa membaca profil yang
// memblokirnya.
describe('JwtAuthGuard optional auth on public routes (Section 6)', () => {
  let request: Record<string, unknown>;
  let prisma: { userSession: { findUnique: jest.Mock }; user: { findUnique: jest.Mock } };
  let redisGet: jest.Mock;
  let verifyAsync: jest.Mock;
  let buildGuard: (failOpen?: boolean) => JwtAuthGuard;

  const healthySession = () => ({
    userId: 'user-1',
    isRevoked: false,
    expiresAt: new Date(Date.now() + 60_000),
    user: { isActive: true, isBanned: false, deletedAt: null },
  });

  beforeEach(() => {
    request = { headers: {} };
    prisma = {
      userSession: { findUnique: jest.fn().mockResolvedValue(healthySession()) },
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ isActive: true, isBanned: false, deletedAt: null }),
      },
    };
    redisGet = jest.fn().mockResolvedValue(null);
    const redisClient = {
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(1),
    };
    verifyAsync = jest
      .fn()
      .mockResolvedValue({ sub: 'user-1', sessionId: 'session-1', jti: 'jti-1' });
    // Reflector: rute ini @Public(), bukan rute admin.
    const reflector = { getAllAndOverride: jest.fn((key: string) => key === 'isPublic') };

    buildGuard = (failOpen = false) =>
      new JwtAuthGuard(
        reflector as never,
        { verifyAsync } as never,
        null,
        {
          get: redisGet,
          getClient: jest.fn(() => redisClient),
          getPrefix: jest.fn(() => 'kahade:'),
        } as never,
        {
          get: jest.fn((key: string) => {
            if (key === 'jwt.secret') return 'test-secret';
            if (key === 'app.redisAuthFailOpen') return failOpen;
            return undefined;
          }),
        } as never,
        prisma as never,
      );
  });

  const withBearer = () => {
    request.headers = { authorization: 'Bearer access-token' };
  };

  it('still allows an anonymous visitor and never parses a token', async () => {
    const guard = buildGuard();
    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request.user).toBeUndefined();
    expect(verifyAsync).not.toHaveBeenCalled();
  });

  it('attaches the viewer when a valid token is presented', async () => {
    withBearer();
    const guard = buildGuard();
    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request.user).toMatchObject({ sub: 'user-1', sessionId: 'session-1' });
  });

  it('accepts a token delivered through the access-token cookie', async () => {
    request.cookies = { kahade_access_token: 'cookie-token' };
    const guard = buildGuard();
    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request.user).toMatchObject({ sub: 'user-1' });
  });

  it('runs the same revocation checks as a protected route before trusting the viewer', async () => {
    withBearer();
    const guard = buildGuard();
    await guard.canActivate(createContext(request));
    expect(redisGet).toHaveBeenCalled();
    expect(prisma.userSession.findUnique).toHaveBeenCalled();
  });

  it.each([
    [
      'the signature does not verify',
      () => verifyAsync.mockRejectedValue(new Error('JsonWebTokenError')),
    ],
    [
      'the token has expired',
      () =>
        verifyAsync.mockRejectedValue(
          Object.assign(new Error('jwt expired'), { name: 'TokenExpiredError' }),
        ),
    ],
    [
      'the jti claim is missing',
      () => verifyAsync.mockResolvedValue({ sub: 'user-1', sessionId: 'session-1' }),
    ],
    [
      'the sessionId claim is missing',
      () => verifyAsync.mockResolvedValue({ sub: 'user-1', jti: 'jti-1' }),
    ],
    ['the token is blacklisted in Redis', () => redisGet.mockResolvedValue('revoked')],
    [
      'the session is revoked in the database',
      () =>
        prisma.userSession.findUnique.mockResolvedValue({ ...healthySession(), isRevoked: true }),
    ],
    [
      'the account is banned',
      () =>
        prisma.userSession.findUnique.mockResolvedValue({
          ...healthySession(),
          user: { isActive: true, isBanned: true, deletedAt: null },
        }),
    ],
    [
      'the account is soft-deleted',
      () =>
        prisma.userSession.findUnique.mockResolvedValue({
          ...healthySession(),
          user: { isActive: true, isBanned: false, deletedAt: new Date() },
        }),
    ],
    [
      'the session belongs to another user',
      () =>
        prisma.userSession.findUnique.mockResolvedValue({
          ...healthySession(),
          userId: 'someone-else',
        }),
    ],
  ])('serves the page anonymously when %s', async (_label, arrange) => {
    withBearer();
    arrange();
    const guard = buildGuard();
    // Rute publik TIDAK boleh berubah jadi 401 hanya karena klien mengirim
    // token basi — yang hilang cuma personalisasi viewer-nya.
    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request.user).toBeUndefined();
  });

  it('stays available when Redis is unreachable and fail-open is disabled', async () => {
    withBearer();
    redisGet.mockRejectedValue(new Error('redis down'));
    const guard = buildGuard(false);
    // Rute terproteksi akan 503 di sini; rute publik harus tetap 200 anonim.
    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request.user).toBeUndefined();
  });

  it('stays available when the database authorization check fails', async () => {
    withBearer();
    prisma.userSession.findUnique.mockRejectedValue(new Error('database unavailable'));
    const guard = buildGuard();
    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request.user).toBeUndefined();
  });

  it('does not weaken protected routes: a missing token is still 401', async () => {
    const reflector = { getAllAndOverride: jest.fn(() => false) };
    const guard = new JwtAuthGuard(
      reflector as never,
      { verifyAsync } as never,
      null,
      {
        get: redisGet,
        getClient: jest.fn(() => ({ get: jest.fn(), del: jest.fn() })),
        getPrefix: jest.fn(() => 'kahade:'),
      } as never,
      {
        get: jest.fn((key: string) => (key === 'jwt.secret' ? 'test-secret' : undefined)),
      } as never,
      prisma as never,
    );
    await expect(guard.canActivate(createContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(request.user).toBeUndefined();
  });
});
