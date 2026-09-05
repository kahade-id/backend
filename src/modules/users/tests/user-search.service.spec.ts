import { Test, TestingModule } from '@nestjs/testing';
import { UserSearchService } from '../user-search.service';
import { PrismaService } from '../../../prisma/prisma.service';

const mockPrisma: any = {
  user: { findMany: jest.fn(), count: jest.fn() },
  blockList: { findMany: jest.fn() },
};

describe('UserSearchService', () => {
  let service: UserSearchService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockPrisma.blockList.findMany.mockResolvedValue([]);
    mockPrisma.user.findMany.mockResolvedValue([]);
    mockPrisma.user.count.mockResolvedValue(0);
    const module: TestingModule = await Test.createTestingModule({
      providers: [UserSearchService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get<UserSearchService>(UserSearchService);
  });

  it('should be defined', () => expect(service).toBeDefined());

  it('returns empty page for no results', async () => {
    const res: any = await service.searchUsers('test', {}, 1, 10);
    expect(res.total).toBe(0);
  });

  it('applies blocked-user filter when viewerId given', async () => {
    mockPrisma.blockList.findMany.mockResolvedValue([
      { blockerId: 'me', blockedId: 'a' },
      { blockerId: 'b', blockedId: 'me' },
    ]);
    await service.searchUsers('x', {}, 1, 10, 'me');
    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { notIn: expect.arrayContaining(['a', 'b']) } }),
    }));
  });

  it('applies KYC and rank filters', async () => {
    await service.searchUsers('x', { isKycVerified: true, membershipRank: 'GOLD', minRating: 4, minTransactions: 5 }, 1, 10);
    const call = mockPrisma.user.findMany.mock.calls[0][0];
    expect(call.where.kycStatus).toBe('APPROVED');
    expect(call.where.membershipRank).toBe('GOLD');
    expect(call.where.averageRating).toEqual({ gte: 4 });
    expect(call.where.totalOrdersCompleted).toEqual({ gte: 5 });
  });

  it('clamps page and limit', async () => {
    await service.searchUsers('', {}, 0, 999);
    const call = mockPrisma.user.findMany.mock.calls[0][0];
    expect(call.skip).toBe(0);
    expect(call.take).toBe(100);
  });

  it('formats user output and computes isKycVerified', async () => {
    mockPrisma.user.findMany.mockResolvedValue([{
      userId: 'KH1', username: 'a', fullName: 'A', avatarUrl: null, bio: 'b',
      membershipRank: 'BRONZE', averageRating: 4.2, totalRatingCount: 3,
      totalOrdersCompleted: 1, kycStatus: 'APPROVED', isVip: true, createdAt: new Date(),
      _count: { followers: 7 },
    }]);
    mockPrisma.user.count.mockResolvedValue(1);
    const res: any = await service.searchUsers('a', {}, 1, 10);
    expect(res.data[0].isKycVerified).toBe(true);
    expect(res.data[0].followersCount).toBe(7);
  });
});
