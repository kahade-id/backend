import { Test, TestingModule } from '@nestjs/testing';
import { SearchService } from '../search.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { VerificationBadgeService } from '../../users/verification-badge.service';

const mockPrisma = {
  user: { findMany: jest.fn(), count: jest.fn() },
  order: { findMany: jest.fn(), count: jest.fn() },
  walletTransaction: { findMany: jest.fn(), count: jest.fn() },
  wallet: { findUnique: jest.fn() },
  blockList: { findMany: jest.fn() },
  $queryRaw: jest.fn(),
};

function makeRedis(lremImpl: (...args: unknown[]) => unknown) {
  const client = {
    lrem: jest.fn(lremImpl),
    lpush: jest.fn().mockResolvedValue(0),
    ltrim: jest.fn().mockResolvedValue(0),
    expire: jest.fn().mockResolvedValue(0),
    lrange: jest.fn().mockResolvedValue([]),
    del: jest.fn().mockResolvedValue(0),
  };
  return { getClient: jest.fn(() => client), __client: client };
}

const mockVerificationBadgeService = {
  getSealTierMap: jest.fn().mockResolvedValue(new Map()),
};

describe('SearchService — removeSearchHistoryItem (BE-IMP item 75)', () => {
  let service: SearchService;
  let mockRedis: ReturnType<typeof makeRedis>;

  async function buildService(lremImpl: (...args: unknown[]) => unknown) {
    jest.resetAllMocks();
    mockRedis = makeRedis(lremImpl);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SearchService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: VerificationBadgeService, useValue: mockVerificationBadgeService },
      ],
    }).compile();
    service = module.get<SearchService>(SearchService);
  }

  it('menghapus entri via LREM dan mengembalikan removed=true', async () => {
    await buildService(() => 1);

    const result = await service.removeSearchHistoryItem('u1', 'kopi susu');

    expect(result).toEqual({ removed: true });
    const client = mockRedis.getClient();
    expect(client.lrem).toHaveBeenCalledWith('search_history:u1', 0, 'kopi susu');
  });

  it('removed=false ketika query tidak ada di riwayat', async () => {
    await buildService(() => 0);

    const result = await service.removeSearchHistoryItem('u1', 'tidak ada');

    expect(result).toEqual({ removed: false });
  });

  it('query kosong → tidak menyentuh Redis', async () => {
    await buildService(() => 1);

    const result = await service.removeSearchHistoryItem('u1', '   ');

    expect(result).toEqual({ removed: false });
    expect(mockRedis.__client.lrem).not.toHaveBeenCalled();
  });

  it('kegagalan Redis → removed=false (best effort, tidak throw)', async () => {
    await buildService(() => {
      throw new Error('redis down');
    });

    const result = await service.removeSearchHistoryItem('u1', 'kopi');

    expect(result).toEqual({ removed: false });
  });

  it('hanya menghapus riwayat milik user yang meminta', async () => {
    await buildService(() => 1);

    await service.removeSearchHistoryItem('user-abc', 'teh');

    expect(mockRedis.__client.lrem).toHaveBeenCalledWith('search_history:user-abc', 0, 'teh');
  });
});
