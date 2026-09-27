import { Test, TestingModule } from '@nestjs/testing';
import { DigitalDeliveryService } from '../services/digital-delivery.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { DigitalAssetType, OrderStatus, ProductType } from '@prisma/client';

const mockPrisma = {
  userShowcase: { findFirst: jest.fn() },
  digitalAsset: { create: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn(), update: jest.fn() },
  order: { findFirst: jest.fn() },
};

const showcaseRow = { id: 's1', userId: 'seller-1', productType: ProductType.DIGITAL };

describe('DigitalDeliveryService', () => {
  let service: DigitalDeliveryService;

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [DigitalDeliveryService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get<DigitalDeliveryService>(DigitalDeliveryService);
  });

  it('menolak aset untuk produk non-DIGITAL', async () => {
    mockPrisma.userShowcase.findFirst.mockResolvedValue({ ...showcaseRow, productType: ProductType.FISIK });
    await expect(
      service.createAsset('seller-1', { showcaseId: 's1', assetType: DigitalAssetType.LINK, payload: 'https://x.id/f' } as never),
    ).rejects.toThrow('harus bertipe DIGITAL');
  });

  it('menolak LINK bukan URL', async () => {
    mockPrisma.userShowcase.findFirst.mockResolvedValue(showcaseRow);
    await expect(
      service.createAsset('seller-1', { showcaseId: 's1', assetType: DigitalAssetType.LINK, payload: 'bukan-url' } as never),
    ).rejects.toThrow('harus URL');
  });

  it('buyer tanpa order berbayar ditolak (fail closed)', async () => {
    mockPrisma.userShowcase.findFirst.mockResolvedValue(showcaseRow);
    mockPrisma.order.findFirst.mockResolvedValue(null);
    await expect(service.listBuyerAssets('buyer-1', 's1')).rejects.toThrow('setelah pembayaran');
    expect(mockPrisma.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: expect.arrayContaining([OrderStatus.PROCESSING]) } }),
      }),
    );
  });

  it('buyer dengan order PROCESSING bisa melihat aset', async () => {
    mockPrisma.userShowcase.findFirst.mockResolvedValue(showcaseRow);
    mockPrisma.order.findFirst.mockResolvedValue({ id: 'o1' });
    mockPrisma.digitalAsset.findMany.mockResolvedValue([{ id: 'd1', assetType: 'LINK' }]);
    const res = await service.listBuyerAssets('buyer-1', 's1');
    expect(res).toHaveLength(1);
  });

  it('owner selalu bisa melihat', async () => {
    mockPrisma.userShowcase.findFirst.mockResolvedValue(showcaseRow);
    mockPrisma.digitalAsset.findMany.mockResolvedValue([]);
    await service.listBuyerAssets('seller-1', 's1');
    expect(mockPrisma.order.findFirst).not.toHaveBeenCalled();
  });
});
