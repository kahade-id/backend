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

// DC-009/R1: SearchService butuh VerificationBadgeService (sealTier).
const mockVerificationBadgeService = {
  getSealTierMap: jest.fn().mockResolvedValue(new Map()),
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
        { provide: VerificationBadgeService, useValue: mockVerificationBadgeService },
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
    // SS-008: filter block sekarang berupa subquery bersarang (nilai
    // interpolasi Sql), bukan literal inline — render rekursif untuk inspeksi.
    function renderSql(call: any[]): string {
      const renderValue = (v: any): string => {
        if (v && Array.isArray(v.strings) && Array.isArray(v.values)) {
          const parts: string[] = [];
          v.strings.forEach((s: string, i: number) => {
            parts.push(s);
            if (i < v.values.length) parts.push(renderValue(v.values[i]));
          });
          return parts.join('');
        }
        if (v && typeof v.text === 'string') return v.text;
        return '[?]';
      };
      const strings: string[] = call[0];
      const values: any[] = call.slice(1);
      const parts: string[] = [];
      strings.forEach((s: string, i: number) => {
        parts.push(s);
        if (i < values.length) parts.push(renderValue(values[i]));
      });
      return parts.join('');
    }

    it('excludes showcase items of blocked users', async () => {
      mockPrisma.blockList.findMany.mockResolvedValue([
        { blockerId: 'u1', blockedId: 'blocked1' },
      ]);
      mockPrisma.$queryRaw.mockResolvedValue([]);
      await service.search('u1', 'kamera', ['showcase']);
      const calls = mockPrisma.$queryRaw.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      // Semua query mentah showcase harus memuat filter NOT IN untuk userId pemilik.
      const sqlTexts = calls.map((c: any[]) => renderSql(c));
      expect(sqlTexts.some((t: string) => t.includes('"userId" NOT IN'))).toBe(true);
      // SS-008: tidak ada lagi array id yang di-unnest; pakai subquery block_lists.
      expect(sqlTexts.some((t: string) => t.includes('FROM block_lists'))).toBe(true);
      expect(sqlTexts.some((t: string) => t.includes('unnest'))).toBe(false);
    });
  });

  describe('discovery contracts (Batch 3C)', () => {
    it('DC-003: searchOrders mengembalikan orderId publik (bukan id internal)', async () => {
      // Cabang LIKE (tanpa tsQuery): mock findMany.
      mockPrisma.order.findMany.mockResolvedValue([
        {
          orderId: 'ORD-20260101-000001-XXXX',
          title: 'Kamera',
          status: 'PENDING',
          orderValue: BigInt(10000000), // 100.000 IDR dalam sen
          createdAt: new Date(),
          buyerId: 'u1',
          buyer: { userId: 'USR-001', username: 'buyer1', fullName: 'Buyer Satu', avatarUrl: null },
          seller: { userId: 'USR-002', username: 'seller1', fullName: 'Seller Satu', avatarUrl: null },
        },
      ]);
      mockPrisma.order.count.mockResolvedValue(1);
      // Paksa cabang LIKE dengan query yang tidak menghasilkan tsQuery valid
      // (buildTsQuery butuh huruf/angka — '!!!' menghasilkan null).
      const res = await service.search('u1', '!!!', ['orders']);
      const orders = (res as any).orders;
      expect(orders).toHaveLength(1);
      // DC-003: harus ada orderId publik, TIDAK ada id internal.
      expect(orders[0].orderId).toBe('ORD-20260101-000001-XXXX');
      expect(orders[0].id).toBeUndefined();
      // DC-005: buyer/seller/myRole harus ada.
      expect(orders[0].buyer.userId).toBe('USR-001');
      expect(orders[0].seller.userId).toBe('USR-002');
      expect(orders[0].myRole).toBe('BUYER');
      // orderValue dalam IDR (bukan sen).
      expect(orders[0].orderValue).toBe(100000);
    });

    it('DC-005: myRole SELLER bila user adalah penjual', async () => {
      mockPrisma.order.findMany.mockResolvedValue([
        {
          orderId: 'ORD-20260101-000002-XXXX',
          title: 'Laptop',
          status: 'PENDING',
          orderValue: BigInt(50000000),
          createdAt: new Date(),
          buyerId: 'u9',
          buyer: { userId: 'USR-009', username: 'buyer9', fullName: 'Buyer Sembilan', avatarUrl: null },
          seller: { userId: 'USR-002', username: 'seller1', fullName: 'Seller Satu', avatarUrl: null },
        },
      ]);
      mockPrisma.order.count.mockResolvedValue(1);
      const res = await service.search('u1', '!!!', ['orders']);
      const orders = (res as any).orders;
      expect(orders[0].myRole).toBe('SELLER');
    });

    it('DC-009: searchUsers mengembalikan userId publik (bukan id internal)', async () => {
      mockPrisma.user.findMany.mockResolvedValue([
        { id: 'cuid-internal-1', userId: 'USR-001', username: 'budi', fullName: 'Budi Santoso', avatarUrl: null },
      ]);
      mockPrisma.user.count.mockResolvedValue(1);
      mockVerificationBadgeService.getSealTierMap.mockResolvedValue(new Map([['cuid-internal-1', 'gold']]));
      const res = await service.search('u1', '!!!', ['users']);
      const users = (res as any).users;
      expect(users).toHaveLength(1);
      expect(users[0].userId).toBe('USR-001');
      expect(users[0].id).toBeUndefined();
      expect(users[0].sealTier).toBe('gold');
    });

    it('DC-015: searchTransactions menyertakan status', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({ id: 'w1' });
      mockPrisma.walletTransaction.findMany.mockResolvedValue([
        {
          id: 'cuid-tx-1',
          txId: 'WLT-20260101-000001',
          type: 'TOPUP',
          amount: BigInt(5000000),
          status: 'COMPLETED',
          description: 'Topup',
          createdAt: new Date(),
        },
      ]);
      mockPrisma.walletTransaction.count.mockResolvedValue(1);
      const res = await service.search('u1', '!!!', ['transactions']);
      const txs = (res as any).transactions;
      expect(txs).toHaveLength(1);
      expect(txs[0].status).toBe('COMPLETED');
      expect(txs[0].txId).toBe('WLT-20260101-000001');
    });

    it('DC-019: searchShowcase mengembalikan userId publik via join', async () => {
      // Cabang tsQuery: mock $queryRaw. Prisma memanggil $queryRaw sebagai
      // tagged template — argumen pertama adalah TemplateStringsArray.
      mockPrisma.$queryRaw.mockImplementation((sql: any) => {
        const sqlStr = Array.isArray(sql) ? sql.join(' ') : String(sql);
        if (sqlStr.includes('COUNT(*)')) return Promise.resolve([{ count: BigInt(1) }]);
        if (sqlStr.includes('FROM user_showcases')) {
          return Promise.resolve([
            { id: 'sc1', title: 'Kamera', description: 'Desc', userId: 'USR-001', createdAt: new Date() },
          ]);
        }
        return Promise.resolve([]);
      });
      const res = await service.search('u1', 'kamera', ['showcase']);
      const items = (res as any).showcase;
      expect(items).toHaveLength(1);
      // DC-009: userId harus publik (dari JOIN users), bukan FK internal.
      expect(items[0].userId).toBe('USR-001');
      // DC-019: bentuk minimal tetap dipertahankan (ada id/title/description/userId/createdAt).
      expect(items[0]).toEqual(
        expect.objectContaining({ id: 'sc1', title: 'Kamera', userId: 'USR-001' }),
      );
    });
  });
});
