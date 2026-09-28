/**
 * Batch 139 BE-API1 — test item 104 & 105.
 *
 * 104: GET /v1/search (scope users) → `membershipRank` per hasil user.
 * 105: GET /v1/search (scope showcase) → rich card: harga, cover image,
 *      counter like/save.
 */
import { SearchService } from '../search.service';

function makeService(prisma: Record<string, unknown>) {
  const service = Object.create(SearchService.prototype) as SearchService;
  (service as any).prisma = prisma;
  (service as any).verificationBadgeService = {
    getSealTierMap: jest.fn(async () => new Map()),
  };
  // Stub agar fokus pada logika baru (perilaku block-list dicakup test existing).
  (service as any).getBlockedUserIds = jest.fn(async () => []);
  return service;
}

describe('Batch 139 BE-API1 — item 104: membershipRank di hasil search users', () => {
  it('jalur fulltext: membershipRank ikut diserialisasi', async () => {
    const rows = [
      { id: 'u1', userId: 'USR-001', username: 'tokomaju', fullName: 'Toko Maju', avatarUrl: null, membershipRank: 'GOLD', rank: 0.9 },
    ];
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValueOnce(rows).mockResolvedValueOnce([{ count: 1n }]),
    };
    const service = makeService(prisma);
    const res = (await (service as any).searchUsers('toko', 'viewer-1')) as {
      results: Array<{ membershipRank: string | null }>;
    };
    expect(res.results).toHaveLength(1);
    expect(res.results[0].membershipRank).toBe('GOLD');
    // SELECT mentah harus memuat kolom membershipRank.
    const sql = String(prisma.$queryRaw.mock.calls[0][0]);
    expect(sql).toContain('membershipRank');
  });

  it('jalur ORM (fallback): membershipRank ikut diserialisasi', async () => {
    const prisma = {
      user: {
        findMany: jest.fn(async () => [
          { id: 'u2', userId: 'USR-002', username: 'warung', fullName: 'Warung', avatarUrl: null, membershipRank: 'SILVER' },
        ]),
        count: jest.fn(async () => 1),
      },
    };
    const service = makeService(prisma);
    // Query tanpa kata alfanumerik → buildTsQuery null → jalur ORM.
    const res = (await (service as any).searchUsers('---', 'viewer-1')) as {
      results: Array<{ membershipRank: string | null }>;
    };
    expect(res.results).toHaveLength(1);
    expect(res.results[0].membershipRank).toBe('SILVER');
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ membershipRank: true }) }),
    );
  });
});

describe('Batch 139 BE-API1 — item 105: rich card hasil search showcase', () => {
  it('jalur fulltext: harga, coverImageUrl, likeCount, saveCount terisi', async () => {
    const rows = [
      {
        id: 'sc-1',
        title: 'Kopi susu',
        description: 'Enak',
        userId: 'USR-001',
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        priceMin: 15000n,
        priceMax: 25000n,
        likeCount: 12,
        saveCount: 3,
        coverImageUrl: 'https://cdn.test/cover.jpg',
      },
    ];
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValueOnce(rows).mockResolvedValueOnce([{ count: 1n }]),
    };
    const service = makeService(prisma);
    const res = (await (service as any).searchShowcase('kopi', 'viewer-1')) as {
      results: Array<{
        priceMin: number | null;
        priceMax: number | null;
        coverImageUrl: string | null;
        likeCount: number;
        saveCount: number;
      }>;
    };
    expect(res.results).toHaveLength(1);
    const item = res.results[0];
    expect(item.priceMin).toBe(15000);
    expect(item.priceMax).toBe(25000);
    expect(item.coverImageUrl).toBe('https://cdn.test/cover.jpg');
    expect(item.likeCount).toBe(12);
    expect(item.saveCount).toBe(3);
    // Bentuk minimal lama tetap subset (additive-only).
    expect(item).toMatchObject({ id: 'sc-1', title: 'Kopi susu', userId: 'USR-001' });
    // Subquery media pertama ada di SQL.
    const sql = String(prisma.$queryRaw.mock.calls[0][0]);
    expect(sql).toContain('showcase_images');
  });

  it('jalur ORM (fallback): rich card terisi, video memakai thumbnail', async () => {
    const prisma = {
      userShowcase: {
        findMany: jest.fn(async () => [
          {
            id: 'sc-2',
            title: 'Video demo',
            description: null,
            createdAt: new Date('2026-09-01T00:00:00.000Z'),
            priceMin: null,
            priceMax: 50000n,
            likeCount: 5,
            saveCount: 1,
            user: { userId: 'USR-003' },
            images: [{ imageUrl: 'https://cdn.test/v.mp4', thumbnailUrl: 'https://cdn.test/v.jpg', kind: 'video' }],
          },
        ]),
        count: jest.fn(async () => 1),
      },
    };
    const service = makeService(prisma);
    const res = (await (service as any).searchShowcase('---', 'viewer-1')) as {
      results: Array<{ priceMin: number | null; priceMax: number | null; coverImageUrl: string | null }>;
    };
    expect(res.results).toHaveLength(1);
    expect(res.results[0].priceMin).toBeNull();
    expect(res.results[0].priceMax).toBe(50000);
    // Video → thumbnail sebagai cover (konsisten serializeShowcase).
    expect(res.results[0].coverImageUrl).toBe('https://cdn.test/v.jpg');
  });
});
