import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PublicService } from '../public.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';

describe('PublicService', () => {
  let svc: PublicService;
  const prisma: any = { systemConfig: { findMany: jest.fn() } };
  const redis: any = { get: jest.fn(), setex: jest.fn() };
  const config: any = { get: jest.fn(() => undefined) };

  beforeEach(async () => {
    jest.resetAllMocks();
    const mod = await Test.createTestingModule({
      providers: [
        PublicService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
        { provide: ConfigService, useValue: config },
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
});
