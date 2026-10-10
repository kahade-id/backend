import { Test, TestingModule } from '@nestjs/testing';
import { BannersService } from '../services/banners.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';

const mockPrisma = {
  banner: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
  },
};

const mockRedis = {
  get: jest.fn().mockResolvedValue(null),
  setex: jest.fn().mockResolvedValue(undefined),
  del: jest.fn().mockResolvedValue(undefined),
  delPattern: jest.fn().mockResolvedValue(undefined),
};

const baseDto = {
  title: 'Promo 9.9',
  imageUrl: 'https://cdn.kahade.id/b/x.png',
  position: 'HOME_TOP',
  startsAt: new Date(Date.now() - 1000).toISOString(),
  endsAt: new Date(Date.now() + 86400000).toISOString(),
};

describe('BannersService', () => {
  let service: BannersService;

  beforeEach(async () => {
    jest.resetAllMocks();
    // Redis di-mock mati agar test menempuh jalur DB (fall-through).
    mockRedis.get.mockResolvedValue(null);
    mockRedis.setex.mockResolvedValue(undefined);
    mockRedis.delPattern.mockResolvedValue(undefined);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BannersService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
      ],
    }).compile();
    service = module.get<BannersService>(BannersService);
  });

  it('menolak endsAt <= startsAt', async () => {
    await expect(
      service.createBanner('admin-1', { ...baseDto, endsAt: baseDto.startsAt } as never),
    ).rejects.toThrow('setelah awal tayang');
    expect(mockPrisma.banner.create).not.toHaveBeenCalled();
  });

  it('getActiveBanners hanya isActive + dalam rentang tayang', async () => {
    mockPrisma.banner.findMany.mockResolvedValue([]);
    await service.getActiveBanners('HOME_TOP');
    expect(mockPrisma.banner.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isActive: true, position: 'HOME_TOP' }),
      }),
    );
    expect(mockRedis.setex).toHaveBeenCalledWith(
      expect.stringContaining('banners:active:'),
      300,
      expect.any(String),
    );
  });

  it('getActiveBanners cache-hit: tidak menyentuh DB', async () => {
    const cachedRows = [{ id: 'b-1', title: 'Promo', imageUrl: 'x', linkUrl: null, position: 'home_top', sortOrder: 0 }];
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(cachedRows));
    const result = await service.getActiveBanners('home_top');
    expect(result).toEqual(cachedRows);
    expect(mockPrisma.banner.findMany).not.toHaveBeenCalled();
  });

  it('getActiveBanners cache korup: fall through ke DB', async () => {
    mockRedis.get.mockResolvedValueOnce('{{{bukan-json');
    mockPrisma.banner.findMany.mockResolvedValue([]);
    await service.getActiveBanners();
    expect(mockPrisma.banner.findMany).toHaveBeenCalled();
  });

  it('update banner sukses meng-invalidate cache banner aktif', async () => {
    mockPrisma.banner.findUnique.mockResolvedValue({ id: 'b-1', startsAt: null, endsAt: null });
    mockPrisma.banner.update.mockResolvedValue({ id: 'b-1' });
    await service.updateBanner('b-1', { title: 'baru' } as never);
    expect(mockRedis.delPattern).toHaveBeenCalledWith('banners:active:*');
  });

  it('update banner hilang → 404', async () => {
    mockPrisma.banner.findUnique.mockResolvedValue(null);
    await expect(service.updateBanner('nope', { title: 'x' } as never)).rejects.toThrow('tidak ditemukan');
  });

  it('delete banner hilang → 404', async () => {
    mockPrisma.banner.findUnique.mockResolvedValue(null);
    await expect(service.deleteBanner('nope')).rejects.toThrow('tidak ditemukan');
    expect(mockPrisma.banner.delete).not.toHaveBeenCalled();
  });

  it('getAdminBanner: banner hilang → 404 BANNER_NOT_FOUND', async () => {
    mockPrisma.banner.findUnique.mockResolvedValue(null);
    await expect(service.getAdminBanner('nope')).rejects.toThrow('tidak ditemukan');
    expect(mockPrisma.banner.findUnique).toHaveBeenCalledWith({ where: { id: 'nope' } });
  });

  it('getAdminBanner: mengembalikan banner apa adanya', async () => {
    const row = { id: 'b-1', title: 'Promo 9.9', isActive: true };
    mockPrisma.banner.findUnique.mockResolvedValue(row);
    await expect(service.getAdminBanner('b-1')).resolves.toBe(row);
  });
});
