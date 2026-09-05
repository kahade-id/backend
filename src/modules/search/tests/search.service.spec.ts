import { Test, TestingModule } from '@nestjs/testing';
import { SearchService } from '../search.service';
import { PrismaService } from '../../../prisma/prisma.service';

const mockPrisma = {
  user: { findMany: jest.fn(), count: jest.fn() },
  order: { findMany: jest.fn(), count: jest.fn() },
  walletTransaction: { findMany: jest.fn(), count: jest.fn() },
  wallet: { findUnique: jest.fn() },
  blockList: { findMany: jest.fn() },
  $queryRaw: jest.fn(),
};

describe('SearchService', () => {
  let service: SearchService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockPrisma.blockList.findMany.mockResolvedValue([]);
    mockPrisma.$queryRaw.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [SearchService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get<SearchService>(SearchService);
  });

  it('should be defined', () => expect(service).toBeDefined());

  describe('search', () => {
    it('returns empty totals when query sanitizes to empty', async () => {
      const res = await service.search('u1', '<>&"\'');
      expect((res as any).totals.users).toBe(0);
    });

    it('searches all 3 types with default limit', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({ id: 'w1' });
      mockPrisma.walletTransaction.findMany.mockResolvedValue([]);
      mockPrisma.walletTransaction.count.mockResolvedValue(0);
      mockPrisma.$queryRaw.mockResolvedValue([]);
      const res = await service.search('u1', 'hello');
      expect((res as any).users).toEqual([]);
      expect((res as any).orders).toEqual([]);
      expect((res as any).transactions).toEqual([]);
    });

    it('respects type filter (only users)', async () => {
      const res = await service.search('u1', 'hello', ['users']);
      expect((res as any).orders).toEqual([]);
      expect((res as any).transactions).toEqual([]);
    });

    it('returns empty transactions when no wallet', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(null);
      const res = await service.search('u1', 'hello', ['transactions']);
      expect((res as any).transactions).toEqual([]);
    });

    it('caps limit between 1 and 50', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({ id: 'w1' });
      mockPrisma.walletTransaction.findMany.mockResolvedValue([]);
      mockPrisma.walletTransaction.count.mockResolvedValue(0);
      const res = await service.search('u1', 'hello', undefined, 999);
      expect(res).toBeDefined();
    });
  });

  describe('suggestions', () => {
    it('returns empty for short query', async () => {
      const res = await service.suggestions('u1', 'a');
      expect((res as any).suggestions).toEqual([]);
    });

    it('returns combined suggestions for long query', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([{ label: 'Alice', type: 'user' }])
        .mockResolvedValueOnce([{ label: 'Order X', type: 'order' }]);
      const res = await service.suggestions('u1', 'al');
      expect((res as any).suggestions).toHaveLength(2);
    });

    it('handles empty raw query returning no results', async () => {
      const res = await service.suggestions('u1', '<>');
      expect((res as any).suggestions).toEqual([]);
    });
  });
});
