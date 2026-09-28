import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ShowcaseVisibility } from '@prisma/client';
import { ShowcaseService } from '../showcase.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { UploadService } from '../../upload/upload.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { VerificationBadgeService } from '../../users/verification-badge.service';
import { SubscriptionsService } from '../../subscriptions/subscriptions.service';
import { AdminShowcaseReportsService } from '../../admin/showcase-reports/admin-showcase-reports.service';

const USER_ID = 'user-1';
const OWNER_ID = 'owner-1';
const SHOWCASE_ID = 'cshowcase000000000000001';
const SHOWCASE_ID_2 = 'cshowcase000000000000002';

function showcaseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SHOWCASE_ID,
    userId: OWNER_ID,
    title: 'Ilustrasi karakter',
    description: 'Deskripsi yang cukup panjang untuk OrderLink.',
    descriptionHtml: null,
    category: 'ilustrasi',
    visibility: ShowcaseVisibility.PUBLIC,
    isActive: true,
    sortOrder: 0,
    condition: null,
    priceMin: 150000n,
    priceMax: null,
    likeCount: 4,
    commentCount: 2,
    viewCount: 10,
    shareCount: 0,
    saveCount: 7,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    images: [],
    user: {
      id: OWNER_ID,
      userId: 'USR-OWNER01',
      username: 'seller',
      fullName: 'Toko Seller',
      avatarUrl: null,
      kycStatus: 'PENDING',
      isVip: false,
      membershipRank: 'BRONZE',
    },
    ...overrides,
  };
}

const mockPrisma: any = {
  blockList: { findFirst: jest.fn(), findMany: jest.fn() },
  userShowcase: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
  showcaseLike: { findMany: jest.fn().mockResolvedValue([]) },
  showcaseSave: { findMany: jest.fn(), count: jest.fn() },
  $transaction: jest.fn(),
};

const mockRedis = { setNx: jest.fn() };
const mockUpload = { verifyUserFileKeys: jest.fn() };
const mockConfig = { get: jest.fn() };
const mockAuditLog = { logAdminAction: jest.fn() };
const mockBadges = { getBadges: jest.fn().mockResolvedValue([]) };
const mockSubscriptions = { isActive: jest.fn().mockResolvedValue(false) };
const mockModeration = {};

describe('ShowcaseService — listSavedShowcases (BE-IMP item 54)', () => {
  let service: ShowcaseService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockPrisma.showcaseLike.findMany.mockResolvedValue([]);
    mockBadges.getBadges.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShowcaseService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: UploadService, useValue: mockUpload },
        { provide: ConfigService, useValue: mockConfig },
        { provide: AuditLogService, useValue: mockAuditLog },
        { provide: VerificationBadgeService, useValue: mockBadges },
        { provide: SubscriptionsService, useValue: mockSubscriptions },
        { provide: AdminShowcaseReportsService, useValue: mockModeration },
      ],
    }).compile();
    service = module.get<ShowcaseService>(ShowcaseService);
  });

  function savedRows() {
    return [
      { id: 'save-2', createdAt: new Date('2026-09-03T00:00:00.000Z'), showcase: showcaseRow({ id: SHOWCASE_ID_2, title: 'Karya kedua' }) },
      { id: 'save-1', createdAt: new Date('2026-09-02T00:00:00.000Z'), showcase: showcaseRow() },
    ];
  }

  it('mengembalikan item tersimpan terbaru dulu dengan savedAt + isSaved=true', async () => {
    mockPrisma.showcaseSave.findMany.mockResolvedValue(savedRows());
    mockPrisma.showcaseSave.count.mockResolvedValue(2);

    const result = (await service.listSavedShowcases(USER_ID, 1, 20)) as any;

    expect(mockPrisma.showcaseSave.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER_ID },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 0,
        take: 20,
      }),
    );
    expect(result.total).toBe(2);
    // createPaginatedResponse memakai key `data` (konsisten dengan feed & endpoint paginated lain).
    expect(result.data).toHaveLength(2);
    expect(result.data[0].id).toBe(SHOWCASE_ID_2);
    expect(result.data[0].savedAt).toEqual(new Date('2026-09-03T00:00:00.000Z'));
    expect(result.data[0].isSaved).toBe(true);
    // Bentuk kartu publik sama seperti feed.
    expect(result.data[0].title).toBe('Karya kedua');
    expect(result.data[0].author.username).toBe('seller');
    expect(result.data[0].saveCount).toBe(7);
  });

  it('mengembalikan daftar kosong ketika user belum menyimpan apa pun', async () => {
    mockPrisma.showcaseSave.findMany.mockResolvedValue([]);
    mockPrisma.showcaseSave.count.mockResolvedValue(0);

    const result = (await service.listSavedShowcases(USER_ID, 1, 20)) as any;

    expect(result.total).toBe(0);
    expect(result.data).toEqual([]);
  });

  it('page kedua memakai skip yang benar', async () => {
    mockPrisma.showcaseSave.findMany.mockResolvedValue([]);
    mockPrisma.showcaseSave.count.mockResolvedValue(25);

    await service.listSavedShowcases(USER_ID, 2, 10);

    expect(mockPrisma.showcaseSave.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 10 }),
    );
  });
});
