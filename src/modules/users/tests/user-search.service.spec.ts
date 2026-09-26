import { Test, TestingModule } from '@nestjs/testing';
import { UserSearchService } from '../user-search.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { VerificationBadgeService } from '../verification-badge.service';

const mockPrisma: any = {
  user: { findMany: jest.fn(), count: jest.fn() },
  blockList: { findMany: jest.fn() },
  follow: { findMany: jest.fn() },
};

const mockVerificationBadgeService = {
  getSealTierMap: jest.fn().mockResolvedValue(new Map()),
};

describe('UserSearchService', () => {
  let service: UserSearchService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockPrisma.blockList.findMany.mockResolvedValue([]);
    mockPrisma.user.findMany.mockResolvedValue([]);
    mockPrisma.user.count.mockResolvedValue(0);
    mockPrisma.follow.findMany.mockResolvedValue([]);
    mockVerificationBadgeService.getSealTierMap.mockResolvedValue(new Map());
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserSearchService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: VerificationBadgeService, useValue: mockVerificationBadgeService },
      ],
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

  it('matches every word for multi-word queries (T1)', async () => {
    await service.searchUsers('budi santoso', {}, 1, 10);
    const call = mockPrisma.user.findMany.mock.calls[0][0];
    // AND per kata — bukan string literal "budi & santoso" yang tak pernah cocok.
    expect(call.where.AND).toHaveLength(2);
    const serialized = JSON.stringify(call.where.AND);
    expect(serialized).not.toContain('&');
    expect(serialized).toContain('budi');
    expect(serialized).toContain('santoso');
  });

  it('DC-006: menyertakan status following untuk viewer', async () => {
    mockPrisma.user.findMany.mockResolvedValue([
      {
        id: 'cuid-1', userId: 'USR-001', username: 'a', fullName: 'A', avatarUrl: null, bio: 'b',
        membershipRank: 'BRONZE', averageRating: 4.2, totalRatingCount: 3,
        totalOrdersCompleted: 1, kycStatus: 'APPROVED', isVip: false, createdAt: new Date(),
        _count: { followers: 7 },
      },
      {
        id: 'cuid-2', userId: 'USR-002', username: 'b', fullName: 'B', avatarUrl: null, bio: 'b',
        membershipRank: 'BRONZE', averageRating: 4.0, totalRatingCount: 1,
        totalOrdersCompleted: 0, kycStatus: 'PENDING', isVip: false, createdAt: new Date(),
        _count: { followers: 2 },
      },
    ]);
    mockPrisma.user.count.mockResolvedValue(2);
    // Viewer mengikuti cuid-1, tidak mengikuti cuid-2.
    mockPrisma.follow.findMany.mockResolvedValue([{ followingId: 'cuid-1' }]);
    const res: any = await service.searchUsers('', {}, 1, 10, 'viewer-1');
    expect(res.data[0].following).toBe(true);
    expect(res.data[1].following).toBe(false);
    // Query follow memakai followerId=viewerId.
    const followCall = mockPrisma.follow.findMany.mock.calls[0][0];
    expect(followCall.where.followerId).toBe('viewer-1');
  });

  it('DC-006: following=false bila tanpa viewerId', async () => {
    mockPrisma.user.findMany.mockResolvedValue([
      {
        id: 'cuid-1', userId: 'USR-001', username: 'a', fullName: 'A', avatarUrl: null, bio: 'b',
        membershipRank: 'BRONZE', averageRating: 4.2, totalRatingCount: 3,
        totalOrdersCompleted: 1, kycStatus: 'APPROVED', isVip: false, createdAt: new Date(),
        _count: { followers: 7 },
      },
    ]);
    mockPrisma.user.count.mockResolvedValue(1);
    const res: any = await service.searchUsers('', {}, 1, 10);
    expect(res.data[0].following).toBe(false);
    expect(mockPrisma.follow.findMany).not.toHaveBeenCalled();
  });
});
