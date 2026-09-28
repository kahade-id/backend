/**
 * Batch 139 BE-API1 — test item 102 & 103.
 *
 * 102: GET /v1/showcase/feed → `author.isFollowing` (satu batch query, bukan N+1).
 * 103: GET /v1/showcase/:id/comments → query param `sort=newest|oldest`.
 */
import { ShowcaseService } from '../showcase.service';

const OWNER_ID = 'owner-1';
const VIEWER_ID = 'viewer-1';

function showcaseRow() {
  return {
    id: 'sc-1',
    userId: OWNER_ID,
    title: 'Komisi ilustrasi',
    description: 'Deskripsi yang cukup panjang untuk lolos validasi.',
    category: 'ilustrasi',
    visibility: 'PUBLIC',
    isActive: true,
    sortOrder: 0,
    condition: null,
    images: [],
    priceMin: 150000n,
    priceMax: 350000n,
    productType: null,
    originalPrice: null,
    serviceDeadlineDays: null,
    likeCount: 1,
    commentCount: 0,
    viewCount: 0,
    shareCount: 0,
    saveCount: 0,
    hotViews: 0,
    descriptionHtml: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    user: {
      id: OWNER_ID,
      userId: 'USR-OWNER01',
      username: 'seller',
      fullName: 'Toko Seller',
      avatarUrl: null,
      membershipRank: 'GOLD',
      kycStatus: 'APPROVED',
      isVip: false,
    },
  };
}

function commentRow(id: string) {
  return {
    id,
    showcaseId: 'sc-1',
    parentId: null,
    content: 'Komentar uji',
    isHidden: false,
    hiddenReason: null,
    createdAt: new Date('2026-09-02T00:00:00.000Z'),
    updatedAt: new Date('2026-09-02T00:00:00.000Z'),
    user: {
      id: 'commenter-1',
      userId: 'USR-COMMENTER',
      username: 'komentator',
      fullName: 'Komentator',
      avatarUrl: null,
      kycStatus: 'APPROVED',
    },
  };
}

function makeService(prisma: Record<string, unknown>) {
  const service = Object.create(ShowcaseService.prototype) as ShowcaseService;
  (service as any).prisma = prisma;
  (service as any).verificationBadgeService = {
    getSealTierMap: jest.fn(async () => new Map()),
  };
  // Kolaborator private yang perilakunya sudah dicakup test existing —
  // di-stub agar fokus pada logika baru item 102/103.
  (service as any).getLikedShowcaseIds = jest.fn(async () => new Set<string>());
  (service as any).getSavedShowcaseIds = jest.fn(async () => new Set<string>());
  (service as any).getAuthorBadgeMap = jest.fn(async () => new Map());
  (service as any).findVisibleShowcase = jest.fn(async () => ({
    row: showcaseRow(),
    isOwner: false,
  }));
  (service as any).getViewerExcludedIds = jest.fn(async () => []);
  return service;
}

describe('Batch 139 BE-API1 — item 102: author.isFollowing di feed', () => {
  it('true bila viewer mengikuti author (satu batch query follow)', async () => {
    const followFindMany = jest.fn(async () => [{ followingId: OWNER_ID }]);
    const service = makeService({ follow: { findMany: followFindMany } });

    const page = (await (service as any).serializeFeedPage(VIEWER_ID, [showcaseRow()], {
      sort: 'latest',
      limit: 20,
      hasMore: false,
      nextCursor: null,
    })) as { items: Array<{ author: { isFollowing: boolean } }> };

    expect(page.items).toHaveLength(1);
    expect(page.items[0].author.isFollowing).toBe(true);
    // Satu query untuk seluruh halaman — bukan N+1 per kartu.
    expect(followFindMany).toHaveBeenCalledTimes(1);
    expect(followFindMany).toHaveBeenCalledWith({
      where: { followerId: VIEWER_ID, followingId: { in: [OWNER_ID] } },
      select: { followingId: true },
    });
  });

  it('false bila viewer tidak mengikuti author', async () => {
    const service = makeService({ follow: { findMany: jest.fn(async () => []) } });
    const page = (await (service as any).serializeFeedPage(VIEWER_ID, [showcaseRow()], {
      sort: 'latest',
      limit: 20,
      hasMore: false,
      nextCursor: null,
    })) as { items: Array<{ author: { isFollowing: boolean } }> };
    expect(page.items[0].author.isFollowing).toBe(false);
  });

  it('false bila viewer anonim (tanpa query follow)', async () => {
    const followFindMany = jest.fn(async () => [{ followingId: OWNER_ID }]);
    const service = makeService({ follow: { findMany: followFindMany } });
    const page = (await (service as any).serializeFeedPage(undefined, [showcaseRow()], {
      sort: 'latest',
      limit: 20,
      hasMore: false,
      nextCursor: null,
    })) as { items: Array<{ author: { isFollowing: boolean } }> };
    expect(page.items[0].author.isFollowing).toBe(false);
    expect(followFindMany).not.toHaveBeenCalled();
  });

  it('false bila viewer adalah author sendiri', async () => {
    const followFindMany = jest.fn(async () => []);
    const service = makeService({ follow: { findMany: followFindMany } });
    const page = (await (service as any).serializeFeedPage(OWNER_ID, [showcaseRow()], {
      sort: 'latest',
      limit: 20,
      hasMore: false,
      nextCursor: null,
    })) as { items: Array<{ author: { isFollowing: boolean } }> };
    expect(page.items[0].author.isFollowing).toBe(false);
    // Diri sendiri dikecualikan → daftar kosong → tanpa query sama sekali.
    expect(followFindMany).not.toHaveBeenCalled();
  });
});

describe('Batch 139 BE-API1 — item 103: sort komentar newest|oldest', () => {
  function makeCommentsService() {
    const findMany = jest.fn(async (args: any) => {
      // Query balasan: where.parentId = id root (truthy). Query root:
      // where.parentId = null (falsy).
      if (args?.where?.parentId) return [];
      return [commentRow('c1')];
    });
    const prisma = {
      showcaseComment: {
        findMany,
        count: jest.fn(async () => 1),
        groupBy: jest.fn(async () => [{ parentId: 'c1', _count: { _all: 1 } }]),
      },
    };
    const service = makeService(prisma);
    return { service, findMany };
  }

  it('default newest: root diurut createdAt desc', async () => {
    const { service, findMany } = makeCommentsService();
    const res = (await service.listComments('sc-1', VIEWER_ID, 1, 20)) as { sort: string };
    const rootCall = findMany.mock.calls.find((c: any[]) => !c[0]?.where?.parentId);
    expect(rootCall?.[0]?.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(res.sort).toBe('newest');
  });

  it("sort=oldest: root diurut createdAt asc, balasan tetap asc", async () => {
    const { service, findMany } = makeCommentsService();
    const res = (await service.listComments('sc-1', VIEWER_ID, 1, 20, 'oldest')) as {
      sort: string;
      data: Array<{ replies: unknown[] }>;
    };
    const rootCall = findMany.mock.calls.find((c: any[]) => !c[0]?.where?.parentId);
    const replyCall = findMany.mock.calls.find((c: any[]) => !!c[0]?.where?.parentId);
    expect(rootCall?.[0]?.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    // Balasan dalam thread tetap kronologis menaik.
    expect(replyCall?.[0]?.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    expect(res.sort).toBe('oldest');
    expect(res.data).toHaveLength(1);
  });
});
