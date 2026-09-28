/**
 * NP-007 (perf-fix, 2026-09-29): kontrak DTO feed ringkas.
 *
 * - Mode excerpt (feed): TIDAK ada alias top-level `imageUrl`, TIDAK ada
 *   field manajemen (`visibility`, `isActive`, `sortOrder`, `updatedAt`).
 *   Sumber kebenaran gambar = `images[]` + `coverImageUrl`.
 * - Mode detail: field manajemen tetap lengkap (kontrak tidak berubah).
 * - `descriptionHtml` = null di excerpt (HTML penuh hanya di detail).
 */
import { __serializeForTest } from '../showcase.service';

const baseRow = {
  id: 'sc-1',
  title: 'Tas Kulit',
  description: 'x'.repeat(300),
  descriptionHtml: '<p>html penuh</p>',
  category: 'FASHION',
  visibility: 'PUBLIC',
  isActive: true,
  sortOrder: 3,
  condition: 'BARU',
  images: [
    {
      id: 'img-1',
      kind: 'image',
      imageUrl: 'https://cdn/img1.jpg',
      fileKey: 'k1',
      thumbnailUrl: 'https://cdn/img1-thumb.jpg',
      durationSec: null,
      width: 800,
      height: 600,
      groupKey: null,
      groupOrder: null,
      sortOrder: 0,
    },
  ],
  priceMin: BigInt(100000),
  priceMax: BigInt(150000),
  productType: null,
  originalPrice: null,
  serviceDeadlineDays: null,
  likeCount: 5,
  commentCount: 2,
  viewCount: 100,
  shareCount: 1,
  saveCount: 3,
  createdAt: new Date('2026-09-29T10:00:00.000Z'),
  updatedAt: new Date('2026-09-29T11:00:00.000Z'),
  user: {
    userId: 'u-1',
    username: 'seller',
    fullName: 'Seller',
    avatarUrl: null,
    membershipRank: 'BRONZE',
    kycStatus: 'APPROVED',
    isVip: false,
  },
};

describe('NP-007 kontrak feed ringkas', () => {
  it('excerpt: tanpa imageUrl top-level & tanpa field manajemen', () => {
    const out = __serializeForTest(baseRow, { excerpt: true });
    expect(out).not.toHaveProperty('imageUrl');
    expect(out).not.toHaveProperty('visibility');
    expect(out).not.toHaveProperty('isActive');
    expect(out).not.toHaveProperty('sortOrder');
    expect(out).not.toHaveProperty('updatedAt');
    expect(out.descriptionHtml).toBeNull();
    // Sumber kebenaran gambar tetap ada.
    expect(out.coverImageUrl).toBe('https://cdn/img1.jpg');
    expect((out.images as Array<{ imageUrl: string }>)[0].imageUrl).toBe('https://cdn/img1.jpg');
    // Deskripsi dipotong 200 karakter.
    expect((out.description as string).length).toBe(200);
    // Field kartu tetap ada.
    expect(out.id).toBe('sc-1');
    expect(out.title).toBe('Tas Kulit');
    expect(out.createdAt).toEqual(baseRow.createdAt);
  });

  it('detail: field manajemen lengkap & kontrak tidak berubah', () => {
    const out = __serializeForTest(baseRow, { excerpt: false });
    expect(out).not.toHaveProperty('imageUrl');
    expect(out.visibility).toBe('PUBLIC');
    expect(out.isActive).toBe(true);
    expect(out.sortOrder).toBe(3);
    expect(out.updatedAt).toEqual(baseRow.updatedAt);
    expect(out.descriptionHtml).toBe('<p>html penuh</p>');
    expect(out.description).toBe('x'.repeat(300));
    expect(out.coverImageUrl).toBe('https://cdn/img1.jpg');
  });

  it('excerpt: video memakai thumbnail sebagai cover', () => {
    const row = {
      ...baseRow,
      images: [
        {
          ...baseRow.images[0],
          kind: 'video',
          imageUrl: 'https://cdn/vid.mp4',
          thumbnailUrl: 'https://cdn/vid-thumb.jpg',
        },
      ],
    };
    const out = __serializeForTest(row, { excerpt: true });
    expect(out.coverImageUrl).toBe('https://cdn/vid-thumb.jpg');
  });
});
