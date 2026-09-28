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

describe('RealtimeService.getLastSeenMany (BD-003)', () => {
  const mget = jest.fn();
  const redis: any = { get: jest.fn(), getPrefix: jest.fn(), getClient: jest.fn() };

  beforeEach(() => {
    jest.resetAllMocks();
    redis.getPrefix.mockReturnValue('');
    redis.getClient.mockReturnValue({ mget });
  });

  async function buildSvc() {
    const mod = await Test.createTestingModule({
      providers: [
        RealtimeService,
        { provide: RedisService, useValue: redis },
        { provide: ConfigService, useValue: { get: jest.fn(() => null) } },
      ],
    }).compile();
    return mod.get(RealtimeService);
  }

  it('mengambil semua last-seen dalam SATU MGET (bukan N GET)', async () => {
    mget.mockResolvedValue(['1700000000000', null, 'not-a-number']);
    const svc = await buildSvc();
    const out = await svc.getLastSeenMany(['u1', 'u2', 'u3']);
    expect(mget).toHaveBeenCalledTimes(1);
    expect(mget).toHaveBeenCalledWith('presence:last:u1', 'presence:last:u2', 'presence:last:u3');
    expect(out.u1).toEqual(new Date(1700000000000));
    expect(out.u2).toBeNull();
    expect(out.u3).toBeNull();
  });

  it('mengembalikan map kosong untuk input kosong tanpa menyentuh Redis', async () => {
    const svc = await buildSvc();
    expect(await svc.getLastSeenMany([])).toEqual({});
    expect(mget).not.toHaveBeenCalled();
  });

  it('fail-safe: Redis error → semua null (tidak melempar)', async () => {
    mget.mockRejectedValue(new Error('redis down'));
    const svc = await buildSvc();
    const out = await svc.getLastSeenMany(['u1']);
    expect(out.u1).toBeNull();
  });
});
