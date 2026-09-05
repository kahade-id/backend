import { Test, TestingModule } from '@nestjs/testing';
import { BadgesService } from '../badges.service';
import { PrismaService } from '../../../prisma/prisma.service';

const mockPrisma = {
  badge: { findMany: jest.fn(), count: jest.fn() },
  userBadge: { findMany: jest.fn(), count: jest.fn() },
};

describe('BadgesService', () => {
  let service: BadgesService;

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BadgesService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get<BadgesService>(BadgesService);
  });

  it('should be defined', () => expect(service).toBeDefined());

  describe('listAllBadges', () => {
    it('returns paginated badges', async () => {
      const badges = [{ id: 'b1', name: 'Pro', userBadges: [{ earnedAt: new Date('2026-08-01T00:00:00.000Z') }] }];
      mockPrisma.badge.findMany.mockResolvedValue(badges);
      mockPrisma.badge.count.mockResolvedValue(1);
      const result = await service.listAllBadges('user-1', 1, 20);
      expect(result.data).toEqual([{ id: 'b1', name: 'Pro', isOwned: true, earnedAt: new Date('2026-08-01T00:00:00.000Z') }]);
      expect(result.total).toBe(1);
    });

    it('caps limit at 100', async () => {
      mockPrisma.badge.findMany.mockResolvedValue([]);
      mockPrisma.badge.count.mockResolvedValue(0);
      await service.listAllBadges('user-1', 1, 999);
      expect(mockPrisma.badge.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
    });

    it('normalizes non-positive page and limit', async () => {
      mockPrisma.badge.findMany.mockResolvedValue([]);
      mockPrisma.badge.count.mockResolvedValue(0);
      const result = await service.listAllBadges('user-1', 0, 0);
      expect(mockPrisma.badge.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 1 }));
      expect(result.page).toBe(1);
      expect(result.limit).toBe(1);
    });

    it('uses defaults when no params provided', async () => {
      mockPrisma.badge.findMany.mockResolvedValue([]);
      mockPrisma.badge.count.mockResolvedValue(0);
      await service.listAllBadges('user-1');
      expect(mockPrisma.badge.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 20 }));
    });
  });

  describe('getMyBadges', () => {
    it('returns user badges with badge details', async () => {
      const userBadges = [{ id: 'ub1', earnedAt: new Date(), badge: { id: 'b1', name: 'Pro' } }];
      mockPrisma.userBadge.findMany.mockResolvedValue(userBadges);
      mockPrisma.userBadge.count.mockResolvedValue(1);
      const result = await service.getMyBadges('user-1');
      expect(result.data).toHaveLength(1);
      expect(result.data[0].badge.name).toBe('Pro');
    });

    it('filters by userId', async () => {
      mockPrisma.userBadge.findMany.mockResolvedValue([]);
      mockPrisma.userBadge.count.mockResolvedValue(0);
      await service.getMyBadges('user-1', 2, 10);
      expect(mockPrisma.userBadge.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user-1' }, skip: 10, take: 10 }));
    });

    it('caps limit at 100', async () => {
      mockPrisma.userBadge.findMany.mockResolvedValue([]);
      mockPrisma.userBadge.count.mockResolvedValue(0);
      await service.getMyBadges('user-1', 1, 500);
      expect(mockPrisma.userBadge.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
    });

    it('normalizes invalid page and limit', async () => {
      mockPrisma.userBadge.findMany.mockResolvedValue([]);
      mockPrisma.userBadge.count.mockResolvedValue(0);
      const result = await service.getMyBadges('user-1', -2, 0);
      expect(mockPrisma.userBadge.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 1 }));
      expect(result.page).toBe(1);
      expect(result.limit).toBe(1);
    });
  });
});
