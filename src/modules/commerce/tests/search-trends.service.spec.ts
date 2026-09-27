import { Test, TestingModule } from '@nestjs/testing';
import { SearchTrendsService } from '../services/search-trends.service';
import { PrismaService } from '../../../prisma/prisma.service';

const mockPrisma = {
  searchKeyword: { upsert: jest.fn(), findMany: jest.fn() },
};

describe('SearchTrendsService', () => {
  let service: SearchTrendsService;

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [SearchTrendsService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get<SearchTrendsService>(SearchTrendsService);
  });

  describe('sanitizeKeyword', () => {
    it('lowercase + trim', () => {
      expect(SearchTrendsService.sanitizeKeyword('  Sepatu Lari ')).toBe('sepatu lari');
    });

    it('menolak nomor HP (PII)', () => {
      expect(SearchTrendsService.sanitizeKeyword('081234567890')).toBeNull();
    });

    it('menolak email (PII)', () => {
      expect(SearchTrendsService.sanitizeKeyword('budi@gmail.com')).toBeNull();
    });

    it('menolak keyword terlalu pendek', () => {
      expect(SearchTrendsService.sanitizeKeyword('a')).toBeNull();
    });
  });

  describe('recordSearch', () => {
    it('menyimpan keyword bersih via upsert', async () => {
      const res = await service.recordSearch({ keyword: 'Kopi Susu' });
      expect(res.recorded).toBe(true);
      expect(mockPrisma.searchKeyword.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { keyword: 'kopi susu' } }),
      );
    });

    it('tidak menyimpan keyword PII', async () => {
      const res = await service.recordSearch({ keyword: '081234567890' });
      expect(res.recorded).toBe(false);
      expect(mockPrisma.searchKeyword.upsert).not.toHaveBeenCalled();
    });
  });

  describe('getTrending', () => {
    it('mengembalikan urutan searchCount desc, limit dibatasi 50', async () => {
      mockPrisma.searchKeyword.findMany.mockResolvedValue([{ keyword: 'kopi', searchCount: 9 }]);
      const res = await service.getTrending(999);
      expect(mockPrisma.searchKeyword.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50 }));
      expect(res).toEqual([{ keyword: 'kopi', searchCount: 9 }]);
    });
  });
});
