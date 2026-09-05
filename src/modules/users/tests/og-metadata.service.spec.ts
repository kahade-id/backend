import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { OgMetadataService } from '../og-metadata.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';

const mockPrisma: any = {
  user: { findUnique: jest.fn() },
  order: { findFirst: jest.fn() },
};
const mockRedis = { get: jest.fn(), set: jest.fn(), del: jest.fn() };

describe('OgMetadataService', () => {
  let service: OgMetadataService;

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OgMetadataService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
      ],
    }).compile();
    service = module.get<OgMetadataService>(OgMetadataService);
  });

  it('should be defined', () => expect(service).toBeDefined());

  describe('getUserOgMetadata', () => {
    it('returns cached metadata when present', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({ title: 'cached' }));
      const res: any = await service.getUserOgMetadata('alice');
      expect(res.title).toBe('cached');
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('throws NotFound when user missing', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.getUserOgMetadata('x')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFound when profile not visible', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue({ profileVisible: false });
      await expect(service.getUserOgMetadata('x')).rejects.toThrow(NotFoundException);
    });

    it('builds OG payload and caches', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue({
        username: 'alice', fullName: 'Alice', avatarUrl: 'http://x/a.png', bio: 'hello',
        membershipRank: 'GOLD', averageRating: 4.5, totalRatingCount: 10,
        totalOrdersCompleted: 20, kycStatus: 'APPROVED', isVip: true, profileVisible: true,
      });
      const res: any = await service.getUserOgMetadata('alice');
      expect(res.title).toContain('Alice');
      expect(res.image).toBe('http://x/a.png');
      expect(res.url).toBe('https://kahade.id/u/alice');
      expect(res.meta['og:url']).toBe('https://kahade.id/u/alice');
      expect(mockRedis.set).toHaveBeenCalled();
    });

    it('uses default image when avatar null', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue({
        username: 'a', fullName: null, avatarUrl: null, bio: null,
        membershipRank: 'BRONZE', averageRating: 0, totalRatingCount: 0,
        totalOrdersCompleted: 0, kycStatus: 'PENDING', isVip: false, profileVisible: true,
      });
      const res: any = await service.getUserOgMetadata('a');
      expect(res.image).toContain('og-default');
    });
  });

  describe('invalidateUserOgCache', () => {
    it('deletes cache key', async () => {
      await service.invalidateUserOgCache('Alice');
      expect(mockRedis.del).toHaveBeenCalledWith('og:user:alice');
    });
  });

  describe('getOrderOgMetadata', () => {
    it('returns cached', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({ title: 'c' }));
      const res: any = await service.getOrderOgMetadata('ord');
      expect(res.title).toBe('c');
    });

    it('throws NotFound when order missing', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockPrisma.order.findFirst.mockResolvedValue(null);
      await expect(service.getOrderOgMetadata('ord')).rejects.toThrow(NotFoundException);
    });

    it('builds OG for order and caches', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockPrisma.order.findFirst.mockResolvedValue({
        orderId: 'O1', title: 'Item', description: 'd', orderType: 'GOODS',
        orderValue: BigInt(100000), status: 'COMPLETED',
        seller: { username: 'a', fullName: 'A', avatarUrl: null },
      });
      const res: any = await service.getOrderOgMetadata('O1');
      expect(res.title).toContain('Item');
      expect(res.url).toBe('https://kahade.id/o/O1');
      expect(res.meta['og:url']).toBe('https://kahade.id/o/O1');
      expect(mockRedis.set).toHaveBeenCalled();
    });
  });
});
