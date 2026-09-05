import { ConfigService } from '@nestjs/config';
import { CsrfService } from './csrf.service';

describe('CsrfService', () => {
  const redis = {
    setex: jest.fn(),
    getAndDelete: jest.fn(),
    del: jest.fn(),
  };
  const config = {
    get: jest.fn().mockReturnValue('15m'),
  };
  let service: CsrfService;

  beforeEach(() => {
    jest.resetAllMocks();
    config.get.mockReturnValue('15m');
    service = new CsrfService(redis as never, config as unknown as ConfigService);
  });

  it('generates a token with the access-token lifetime', async () => {
    redis.setex.mockResolvedValue(undefined);

    const token = await service.generateToken('user-1', 'jti-1');

    expect(token).toMatch(/^[0-9a-f]{64}$/i);
    expect(redis.setex).toHaveBeenCalledWith(expect.stringMatching(/^csrf:user-1:jti-1:[0-9a-f]{64}$/), 900, '1', { throwOnError: true });
  });

  it('atomically consumes a valid token and never performs a separate delete', async () => {
    const token = 'a'.repeat(64);
    redis.getAndDelete.mockResolvedValue('1');

    await expect(service.validateToken('user-1', 'jti-1', token)).resolves.toBe(true);

    expect(redis.getAndDelete).toHaveBeenCalledWith(expect.stringMatching(/^csrf:user-1:jti-1:[0-9a-f]{64}$/), { throwOnError: true });
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('rejects a token that has already been consumed', async () => {
    redis.getAndDelete.mockResolvedValue(null);

    await expect(service.validateToken('user-1', 'jti-1', 'a'.repeat(64))).resolves.toBe(false);
    expect(redis.getAndDelete).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed tokens before touching Redis', async () => {
    await expect(service.validateToken('user-1', 'jti-1', 'not-hex')).resolves.toBe(false);
    expect(redis.getAndDelete).not.toHaveBeenCalled();
  });
});
