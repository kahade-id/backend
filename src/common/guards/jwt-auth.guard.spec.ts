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

    await expect(guard.canActivate(createContext(request))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an active session owned by a banned account', async () => {
    prisma.userSession.findUnique.mockResolvedValue({
      userId: 'user-1',
      isRevoked: false,
      expiresAt: new Date(Date.now() + 60_000),
      user: { isActive: true, isBanned: true, deletedAt: null },
    });

    await expect(guard.canActivate(createContext(request))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('fails closed when the database authorization check is unavailable', async () => {
    prisma.userSession.findUnique.mockRejectedValue(new Error('database unavailable'));

    await expect(guard.canActivate(createContext(request))).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
