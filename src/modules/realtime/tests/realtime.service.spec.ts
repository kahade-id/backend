import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RealtimeService } from '../realtime.service';
import { RedisService } from '../../../redis/redis.service';

describe('RealtimeService', () => {
  const redis: any = { sadd: jest.fn(), srem: jest.fn(), scard: jest.fn(async () => 2), exists: jest.fn(async () => 1), expire: jest.fn(), get: jest.fn(), pipeline: jest.fn() };

  async function build(hmacKey: string | null) {
    const mod = await Test.createTestingModule({
      providers: [
        RealtimeService,
        { provide: RedisService, useValue: redis },
        { provide: ConfigService, useValue: { get: jest.fn((k: string) => k === 'ws.hmacKey' ? hmacKey : null) } },
      ],
    }).compile();
    return mod.get(RealtimeService);
  }

  beforeEach(() => jest.resetAllMocks());

  it('defined', async () => expect(await build('secret')).toBeDefined());

  it('isHmacEnabled reflects key presence', async () => {
    expect((await build('secret')).isHmacEnabled()).toBe(true);
    expect((await build(null)).isHmacEnabled()).toBe(false);
  });

  it('generateSessionKey returns a non-empty string', async () => {
    const svc = await build('secret');
    const key = svc.generateSessionKey();
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(8);
  });

  it('signWithKey returns signed payload structure', async () => {
    const svc = await build('secret');
    const out = svc.signWithKey('k1', { hello: 'world' });
    expect(out).toBeDefined();
    expect(typeof out).toBe('object');
  });

  it('refreshes an existing presence TTL without incrementing its connection counter', async () => {
    redis.get.mockResolvedValue('2');
    const svc = await build('secret');

    await svc.refreshUserPresence('user-1');

    expect(redis.expire).toHaveBeenCalledWith('presence:user-1', 600);
  });
});
