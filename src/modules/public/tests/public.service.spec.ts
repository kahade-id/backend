import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PublicService } from '../public.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { OpsSettingsService } from '../../ops-settings/ops-settings.service';

describe('PublicService', () => {
  let svc: PublicService;
  const prisma: any = {
    systemConfig: { findMany: jest.fn() },
    order: { count: jest.fn() },
    user: { count: jest.fn() },
    rating: { aggregate: jest.fn() },
    shipment: { groupBy: jest.fn() },
  };
  const redis: any = { get: jest.fn(), setex: jest.fn() };
  const config: any = { get: jest.fn(() => undefined) };
  const opsSettings: any = { get: jest.fn(() => undefined) };

  beforeEach(async () => {
    jest.resetAllMocks();
    const mod = await Test.createTestingModule({
      providers: [
        PublicService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
        { provide: ConfigService, useValue: config },
        { provide: OpsSettingsService, useValue: opsSettings },
      ],
    }).compile();
    svc = mod.get(PublicService);
  });

  it('defined', () => expect(svc).toBeDefined());

  it('getBanks returns the static bank list', () => {
    const res = svc.getBanks();
    expect(res.banks.length).toBeGreaterThan(5);
    expect(res.banks.find(b => b.code === 'BCA')).toBeDefined();
  });

  it('getFeeSchedule returns defaults when config missing', () => {
    const res: any = svc.getFeeSchedule();
    expect(res.feeSchedule.standardFeeRate).toBe(2.5);
    expect(res.feeSchedule.currency).toBe('IDR');
  });

  it('getPublicConfigs returns cached payload when present', async () => {
    redis.get.mockResolvedValue(JSON.stringify({ configs: [{ key: 'a', value: 'b', description: null, dataType: 'string', updatedAt: new Date() }] }));
    const res = await svc.getPublicConfigs();
    expect(res.configs[0].key).toBe('a');
    expect(prisma.systemConfig.findMany).not.toHaveBeenCalled();
  });

  it('getPublicConfigs queries DB and caches when no cache', async () => {
    redis.get.mockResolvedValue(null);
    prisma.systemConfig.findMany.mockResolvedValue([]);
    const res = await svc.getPublicConfigs();
    expect(res.configs).toEqual([]);
    expect(redis.setex).toHaveBeenCalled();
  });

  describe('getPublicStats', () => {
    const statsCacheKey = 'public:stats:aggregate';

    function mockDb(stats: {
      orders?: number;
      users?: number;
      avgStars?: number | null;
      origins?: Array<string | null>;
      dests?: Array<string | null>;
    }) {
      prisma.order.count.mockResolvedValue(stats.orders ?? 0);
      prisma.user.count.mockResolvedValue(stats.users ?? 0);
      prisma.rating.aggregate.mockResolvedValue({ _avg: { stars: stats.avgStars ?? null } });
      prisma.shipment.groupBy
        .mockResolvedValueOnce((stats.origins ?? []).map((c) => ({ originCity: c })))
        .mockResolvedValueOnce((stats.dests ?? []).map((c) => ({ destCity: c })));
    }

    it('returns cached payload without hitting DB when cache present', async () => {
      const cached = { transactionsCount: 10, usersCount: 20, citiesCount: 3, ratingAvg: 4.5 };
      redis.get.mockResolvedValue(JSON.stringify(cached));
      const res = await svc.getPublicStats();
      expect(res).toEqual(cached);
      expect(redis.get).toHaveBeenCalledWith(statsCacheKey);
      expect(prisma.order.count).not.toHaveBeenCalled();
      expect(prisma.user.count).not.toHaveBeenCalled();
    });

    it('aggregates from DB and caches for 600s when no cache', async () => {
      redis.get.mockResolvedValue(null);
      mockDb({ orders: 123, users: 456, avgStars: 4.666, origins: ['Jakarta', 'Bandung'], dests: ['Surabaya'] });
      const res = await svc.getPublicStats();
      expect(res).toEqual({ transactionsCount: 123, usersCount: 456, citiesCount: 3, ratingAvg: 4.7 });
      // Hanya order COMPLETED yang dihitung sebagai transaksi.
      expect(prisma.order.count).toHaveBeenCalledWith({ where: { status: 'COMPLETED' } });
      // User yang di-ban / nonaktif tidak dihitung.
      expect(prisma.user.count).toHaveBeenCalledWith({ where: { isActive: true, isBanned: false } });
      // Rating tersembunyi tidak ikut rata-rata.
      expect(prisma.rating.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isHidden: false } }),
      );
      expect(redis.setex).toHaveBeenCalledWith(statsCacheKey, 600, JSON.stringify(res));
    });

    it('dedupes cities case-insensitively and ignores blanks', async () => {
      redis.get.mockResolvedValue(null);
      mockDb({
        origins: ['Jakarta', ' JAKARTA ', '', null],
        dests: ['jakarta', 'Medan'],
      });
      const res = await svc.getPublicStats();
      expect(res.citiesCount).toBe(2);
    });

    it('returns ratingAvg null when there are no visible ratings', async () => {
      redis.get.mockResolvedValue(null);
      mockDb({ avgStars: null });
      const res = await svc.getPublicStats();
      expect(res.ratingAvg).toBeNull();
    });

    it('falls through to DB when Redis read fails', async () => {
      redis.get.mockRejectedValue(new Error('redis down'));
      mockDb({ orders: 7, users: 8 });
      const res = await svc.getPublicStats();
      expect(res.transactionsCount).toBe(7);
      expect(res.usersCount).toBe(8);
    });

    it('still returns DB result when Redis write fails', async () => {
      redis.get.mockResolvedValue(null);
      redis.setex.mockRejectedValue(new Error('redis down'));
      mockDb({ orders: 1 });
      const res = await svc.getPublicStats();
      expect(res.transactionsCount).toBe(1);
    });
  });
});
