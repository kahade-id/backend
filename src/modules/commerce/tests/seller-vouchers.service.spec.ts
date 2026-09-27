import { Test, TestingModule } from '@nestjs/testing';
import { SellerVouchersService } from '../services/seller-vouchers.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { VoucherType } from '@prisma/client';

const mockPrisma = {
  voucher: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), findMany: jest.fn(), count: jest.fn(), update: jest.fn() },
  voucherUsage: { count: jest.fn() },
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
});
