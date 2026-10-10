import { Test, TestingModule } from '@nestjs/testing';
import { ProductCommerceService } from '../services/product-commerce.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { ProductType, OrderStatus } from '@prisma/client';

const mockPrisma = {
  userShowcase: {
    findFirst: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  order: { count: jest.fn() },
};

describe('ProductCommerceService', () => {
  let service: ProductCommerceService;

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [ProductCommerceService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get<ProductCommerceService>(ProductCommerceService);
  });

  it('should be defined', () => expect(service).toBeDefined());

  describe('updateCommerceFields', () => {
    const baseRow = {
      id: 's1',
      userId: 'u1',
      // UserShowcase.priceMin disimpan dalam IDR (BigInt), BUKAN sen —
      // lihat ShowcaseService.createShowcaseItem (BigInt(dto.priceMin)).
      priceMin: 100000n, // Rp100.000
      priceMax: null,
      productType: null,
      serviceDeadlineDays: null,
      originalPrice: null,
    };

    it('menolak JASA tanpa tenggat pengerjaan', async () => {
      mockPrisma.userShowcase.findFirst.mockResolvedValue(baseRow);
      await expect(
        service.updateCommerceFields('u1', 's1', { productType: ProductType.JASA }),
      ).rejects.toThrow('tenggat pengerjaan');
    });

    it('menerima JASA dengan tenggat pengerjaan', async () => {
      mockPrisma.userShowcase.findFirst.mockResolvedValue(baseRow);
      mockPrisma.userShowcase.update.mockResolvedValue({ id: 's1', productType: 'JASA' });
      await service.updateCommerceFields('u1', 's1', { productType: ProductType.JASA, serviceDeadlineDays: 7 });
      expect(mockPrisma.userShowcase.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ productType: ProductType.JASA, serviceDeadlineDays: 7 }),
        }),
      );
    });

    it('menolak harga coret <= harga jual', async () => {
      mockPrisma.userShowcase.findFirst.mockResolvedValue(baseRow);
      await expect(
        service.updateCommerceFields('u1', 's1', { originalPriceIdr: 90000 }),
      ).rejects.toThrow('lebih besar dari harga jual');
    });

    it('menerima harga coret > harga jual', async () => {
      mockPrisma.userShowcase.findFirst.mockResolvedValue(baseRow);
      mockPrisma.userShowcase.update.mockResolvedValue({ id: 's1' });
      await service.updateCommerceFields('u1', 's1', { originalPriceIdr: 150000 });
      expect(mockPrisma.userShowcase.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ originalPrice: 15000000n }) }),
      );
    });

    it('satuan: harga coret Rp2.000 pada barang Rp100.000 DITOLAK (dulu lolos karena sen vs IDR)', async () => {
      mockPrisma.userShowcase.findFirst.mockResolvedValue(baseRow);
      await expect(
        service.updateCommerceFields('u1', 's1', { originalPriceIdr: 2000 }),
      ).rejects.toThrow('lebih besar dari harga jual');
      expect(mockPrisma.userShowcase.update).not.toHaveBeenCalled();
    });

    it('null menghapus harga coret (bukan RangeError 500)', async () => {
      mockPrisma.userShowcase.findFirst.mockResolvedValue({ ...baseRow, originalPrice: 15000000n });
      mockPrisma.userShowcase.update.mockResolvedValue({ id: 's1', originalPrice: null });
      await service.updateCommerceFields('u1', 's1', { originalPriceIdr: null } as any);
      expect(mockPrisma.userShowcase.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ originalPrice: null }) }),
      );
    });

    it('menolak scheduledAt di masa lalu', async () => {
      mockPrisma.userShowcase.findFirst.mockResolvedValue(baseRow);
      await expect(
        service.updateCommerceFields('u1', 's1', { scheduledAt: new Date(Date.now() - 1000).toISOString() }),
      ).rejects.toThrow('masa depan');
    });

    it('404 bila bukan milik user', async () => {
      mockPrisma.userShowcase.findFirst.mockResolvedValue(null);
      await expect(service.updateCommerceFields('u2', 's1', {})).rejects.toThrow('Etalase tidak ditemukan');
    });
  });

  describe('recordClick', () => {
    it('increment atomik', async () => {
      mockPrisma.userShowcase.updateMany.mockResolvedValue({ count: 1 });
      await service.recordClick('s1');
      expect(mockPrisma.userShowcase.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { clickCount: { increment: 1 } } }),
      );
    });
  });

  describe('getProductStats', () => {
    it('menolak non-pemilik', async () => {
      mockPrisma.userShowcase.findFirst.mockResolvedValue({ id: 's1', userId: 'u1', viewCount: 1, saveCount: 0, likeCount: 0, shareCount: 0, clickCount: 0, hotViews: 0 });
      await expect(service.getProductStats('u2', 's1')).rejects.toThrow('hanya bisa dibaca pemilik');
    });

    it('mengembalikan agregat termasuk purchases on-read', async () => {
      mockPrisma.userShowcase.findFirst.mockResolvedValue({ id: 's1', userId: 'u1', viewCount: 10, saveCount: 2, likeCount: 3, shareCount: 1, clickCount: 5, hotViews: 4 });
      mockPrisma.order.count.mockResolvedValueOnce(7).mockResolvedValueOnce(9);
      const stats = await service.getProductStats('u1', 's1');
      expect(stats.purchases).toBe(7);
      expect(stats.ordersTotal).toBe(9);
      expect(mockPrisma.order.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: OrderStatus.COMPLETED }) }),
      );
    });
  });

  describe('getProductBadges', () => {
    it('TERLARIS bila >= 10 order selesai 90 hari', async () => {
      mockPrisma.userShowcase.findFirst.mockResolvedValue({ id: 's1', originalPrice: null });
      mockPrisma.order.count.mockResolvedValue(12);
      const res = await service.getProductBadges('s1');
      expect(res.badges).toContain('TERLARIS');
    });

    it('tanpa badge bila di bawah ambang', async () => {
      mockPrisma.userShowcase.findFirst.mockResolvedValue({ id: 's1', originalPrice: null });
      mockPrisma.order.count.mockResolvedValue(3);
      const res = await service.getProductBadges('s1');
      expect(res.badges).toEqual([]);
    });
  });
});
