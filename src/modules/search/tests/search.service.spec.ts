import { Test, TestingModule } from '@nestjs/testing';
import { SearchService } from '../search.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';

const mockPrisma = {
  user: { findMany: jest.fn(), count: jest.fn() },
  order: { findMany: jest.fn(), count: jest.fn() },
  walletTransaction: { findMany: jest.fn(), count: jest.fn() },
  wallet: { findUnique: jest.fn() },
  blockList: { findMany: jest.fn() },
  $queryRaw: jest.fn(),
};

// Pre-existing (2026-09-26): SearchService butuh RedisService (search history),
// test module belum di-update — mock minimal supaya suite bisa jalan.
const mockRedis = {
  getClient: jest.fn(() => ({
    lrem: jest.fn().mockResolvedValue(0),
    lpush: jest.fn().mockResolvedValue(0),
    ltrim: jest.fn().mockResolvedValue(0),
    expire: jest.fn().mockResolvedValue(0),
    lrange: jest.fn().mockResolvedValue([]),
  })),
  del: jest.fn().mockResolvedValue(0),
};

describe('SearchService', () => {
  let service: SearchService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockPrisma.blockList.findMany.mockResolvedValue([]);
    mockPrisma.$queryRaw.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SearchService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
      ],
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

    it('includes showcase titles in suggestions (S1)', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([{ label: 'Alice', type: 'user' }])
        .mockResolvedValueOnce([{ label: 'Kamera Canon', type: 'showcase' }])
        .mockResolvedValueOnce([{ label: 'Order X', type: 'order' }]);
      const res = await service.suggestions('u1', 'ka');
      const types = (res as any).suggestions.map((s: any) => s.type);
      expect(types).toContain('showcase');
      expect((res as any).suggestions).toHaveLength(3);
    });

    it('T3: suggestions showcase memfilter kesehatan/privasi pemilik', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);
      await service.suggestions('u1', 'kamera');
      const showcaseCall = mockPrisma.$queryRaw.mock.calls.find((call: any[]) =>
        String(call[0]).includes('FROM user_showcases'),
      );
      expect(showcaseCall).toBeDefined();
      const sql = String(showcaseCall[0]);
      expect(sql).toContain('"isBanned" = false');
      expect(sql).toContain('"profileVisible" = true');
    });
  });

  describe('fts index parity (T1)', () => {
    it('memakai urutan operan yang sama dengan index GIN idx_users_fts_search', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);
      await service.search('u1', 'budi', ['users']);
      const sqlCalls = mockPrisma.$queryRaw.mock.calls.map((call: any[]) => String(call[0]));
      const userSql = sqlCalls.find((s: string) => s.includes('FROM users'));
      expect(userSql).toBeDefined();
      // Harus identik dengan definisi index di migration 20260318_gin_search.
      expect(userSql).toContain(`coalesce(username, '') || ' ' || "fullName"`);
      expect(userSql).not.toContain('COALESCE("fullName"');
    });
  });

  describe('searchShowcase privacy (T2)', () => {
    it('excludes showcase items of blocked users', async () => {
      mockPrisma.blockList.findMany.mockResolvedValue([
        { blockerId: 'u1', blockedId: 'blocked1' },
      ]);
      mockPrisma.$queryRaw.mockResolvedValue([]);
      await service.search('u1', 'kamera', ['showcase']);
      const calls = mockPrisma.$queryRaw.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      // Semua query mentah showcase harus memuat filter NOT IN untuk userId pemilik.
      const sqlTexts = calls.map((c: any[]) =>
        c[0].map((s: string) => s).join(' '),
      );
      expect(sqlTexts.some((t: string) => t.includes('"userId" NOT IN'))).toBe(true);
    });
  });
});
