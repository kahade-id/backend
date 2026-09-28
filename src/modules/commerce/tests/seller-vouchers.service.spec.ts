import { Test, TestingModule } from '@nestjs/testing';
import { SellerVouchersService } from '../services/seller-vouchers.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { VoucherType } from '@prisma/client';

const mockPrisma = {
  voucher: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), findFirst: jest.fn(), create: jest.fn(), findMany: jest.fn(), count: jest.fn(), update: jest.fn() },
  voucherUsage: { count: jest.fn() },
  user: { findMany: jest.fn() },
};

const adminVoucherRow = {
  id: 'v1', code: 'HEMAT10', name: 'Hemat 10rb', description: null,
  voucherType: 'FEE_DISCOUNT_FLAT', discountAmount: 1000000n, discountPercent: null,
  maxDiscountAmount: null, maxUsageTotal: 100, maxUsagePerUser: 1, currentUsage: 3,
  minOrderValue: null, isActive: true,
  validFrom: new Date('2026-09-01T00:00:00Z'), validUntil: new Date('2026-12-31T00:00:00Z'),
  sellerId: 'seller-1', createdBy: 'SELLER_seller-1',
  createdAt: new Date('2026-09-28T00:00:00Z'), updatedAt: new Date('2026-09-28T00:00:00Z'),
};

const baseDto = {
  code: 'hemat10',
  name: 'Hemat 10rb',
  voucherType: VoucherType.FEE_DISCOUNT_FLAT,
  discountAmountIdr: 10000,
  validFrom: new Date(Date.now() - 1000).toISOString(),
  validUntil: new Date(Date.now() + 86400000).toISOString(),
};

describe('SellerVouchersService', () => {
  let service: SellerVouchersService;

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [SellerVouchersService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get<SellerVouchersService>(SellerVouchersService);
  });

  describe('createVoucher', () => {
    it('membuat voucher dengan sellerId + kode uppercase', async () => {
      mockPrisma.voucher.findUnique.mockResolvedValue(null);
      mockPrisma.voucher.create.mockResolvedValue({ id: 'v1', code: 'HEMAT10', discountAmount: 1000000n, discountPercent: null, maxDiscountAmount: null, minOrderValue: null });
      const res = await service.createVoucher('seller-1', baseDto as never);
      expect(mockPrisma.voucher.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ sellerId: 'seller-1', code: 'HEMAT10' }) }),
      );
      expect(res.discountAmount).toBe(10000);
    });

    it('menolak kode duplikat', async () => {
      mockPrisma.voucher.findUnique.mockResolvedValue({ id: 'v0' });
      await expect(service.createVoucher('seller-1', baseDto as never)).rejects.toThrow('sudah dipakai');
    });

    it('menolak tipe persen tanpa discountPercent', async () => {
      await expect(
        service.createVoucher('seller-1', { ...baseDto, voucherType: VoucherType.FEE_DISCOUNT_PERCENT } as never),
      ).rejects.toThrow('discountPercent wajib');
    });

    it('menolak validUntil <= validFrom', async () => {
      await expect(
        service.createVoucher('seller-1', { ...baseDto, validUntil: baseDto.validFrom } as never),
      ).rejects.toThrow('harus setelah validFrom');
    });
  });

  describe('validateVoucher', () => {
    const voucherRow = {
      id: 'v1',
      code: 'HEMAT10',
      name: 'Hemat',
      sellerId: 'seller-1',
      voucherType: VoucherType.FEE_DISCOUNT_FLAT,
      discountAmount: 1000000n,
      discountPercent: null,
      maxDiscountAmount: null,
      minOrderValue: 5000000n,
      isActive: true,
      validFrom: new Date(Date.now() - 1000),
      validUntil: new Date(Date.now() + 86400000),
      maxUsageTotal: null,
      currentUsage: 0,
      maxUsagePerUser: 1,
    };

    it('valid: menghitung estimasi diskon', async () => {
      mockPrisma.voucher.findUnique.mockResolvedValue(voucherRow);
      mockPrisma.voucherUsage.count.mockResolvedValue(0);
      const res = await service.validateVoucher('buyer-1', { code: 'hemat10', orderValueIdr: 100000, sellerId: 'seller-1' });
      expect(res.valid).toBe(true);
      expect(res.discountIdr).toBe(10000);
    });

    it('menolak bila voucher milik seller lain', async () => {
      mockPrisma.voucher.findUnique.mockResolvedValue(voucherRow);
      await expect(
        service.validateVoucher('buyer-1', { code: 'HEMAT10', orderValueIdr: 100000, sellerId: 'seller-2' }),
      ).rejects.toThrow('tidak valid untuk toko ini');
    });

    it('menolak bila di bawah min belanja', async () => {
      mockPrisma.voucher.findUnique.mockResolvedValue(voucherRow);
      await expect(
        service.validateVoucher('buyer-1', { code: 'HEMAT10', orderValueIdr: 10000, sellerId: 'seller-1' }),
      ).rejects.toThrow('Minimal belanja');
    });

    it('menolak bila kuota habis', async () => {
      mockPrisma.voucher.findUnique.mockResolvedValue({ ...voucherRow, maxUsageTotal: 5, currentUsage: 5 });
      await expect(
        service.validateVoucher('buyer-1', { code: 'HEMAT10', orderValueIdr: 100000, sellerId: 'seller-1' }),
      ).rejects.toThrow('Kuota voucher habis');
    });
  });

  describe('deactivateVoucher', () => {
    it('hanya pemilik yang bisa menonaktifkan', async () => {
      mockPrisma.voucher.findFirst.mockResolvedValue(null);
      await expect(service.deactivateVoucher('seller-2', 'v1')).rejects.toThrow('tidak ditemukan');
    });
  });

  describe('admin', () => {
    it('listAdminVouchers mengembalikan shape admin + sellerName', async () => {
      mockPrisma.voucher.findMany.mockResolvedValue([adminVoucherRow]);
      mockPrisma.voucher.count.mockResolvedValue(1);
      mockPrisma.user.findMany.mockResolvedValue([{ id: 'seller-1', fullName: 'Toko A' }]);
      const res = await service.listAdminVouchers(1, 20, 'true');
      expect(res.total).toBe(1);
      expect(res.data[0]).toMatchObject({
        id: 'v1', code: 'HEMAT10', sellerId: 'seller-1', sellerName: 'Toko A',
        discountAmount: 10000, usageQuota: 100, usageCount: 3, isActive: true,
      });
    });

    it('getAdminVoucherDetail memetakan usages + user', async () => {
      mockPrisma.voucher.findFirst.mockResolvedValue({
        ...adminVoucherRow,
        usages: [{
          id: 'u1', discountApplied: 1000000n, orderId: 'o1', usedAt: new Date('2026-09-28T02:00:00Z'),
          user: { id: 'buyer-1', fullName: 'Buyer B', email: 'b@x.id', phoneNumber: '6281' },
        }],
      });
      mockPrisma.user.findMany.mockResolvedValue([{ id: 'seller-1', fullName: 'Toko A' }]);
      const res = await service.getAdminVoucherDetail('v1');
      expect(res.sellerName).toBe('Toko A');
      expect(res.usages[0]).toMatchObject({
        id: 'u1', discountApplied: 10000, orderId: 'o1',
        user: { id: 'buyer-1', fullName: 'Buyer B', email: 'b@x.id', phone: '6281' },
      });
    });

    it('deactivateAdminVoucher idempoten bila sudah nonaktif', async () => {
      mockPrisma.voucher.findFirst.mockResolvedValue({ id: 'v1', isActive: false, sellerId: 'seller-1' });
      mockPrisma.voucher.findUniqueOrThrow = jest.fn().mockResolvedValue({ ...adminVoucherRow, isActive: false });
      mockPrisma.user.findMany.mockResolvedValue([{ id: 'seller-1', fullName: 'Toko A' }]);
      const res = await service.deactivateAdminVoucher('v1', 'admin-1');
      expect(mockPrisma.voucher.update).not.toHaveBeenCalled();
      expect(res.isActive).toBe(false);
    });
  });
});
