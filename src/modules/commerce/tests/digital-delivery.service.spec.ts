import { Test, TestingModule } from '@nestjs/testing';
import { DigitalDeliveryService } from '../services/digital-delivery.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { UploadService } from '../../upload/upload.service';
import { UploadPurpose } from '../../upload/dto/presigned-url.dto';
import { DigitalAssetType, OrderStatus, ProductType } from '@prisma/client';

const mockPrisma = {
  userShowcase: { findFirst: jest.fn() },
  digitalAsset: { create: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn(), update: jest.fn() },
  order: { findFirst: jest.fn() },
};
const mockUpload = {
  verifyUserFileKeys: jest.fn(),
  consumeUploadConfirmations: jest.fn(),
  createSignedDownloadUrl: jest.fn(),
};

const showcaseRow = { id: 's1', userId: 'seller-1', productType: ProductType.DIGITAL };

describe('DigitalDeliveryService', () => {
  let service: DigitalDeliveryService;

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [DigitalDeliveryService, { provide: PrismaService, useValue: mockPrisma }, { provide: UploadService, useValue: mockUpload }],
    }).compile();
    service = module.get<DigitalDeliveryService>(DigitalDeliveryService);
  });

  it('menolak aset untuk produk non-DIGITAL', async () => {
    mockPrisma.userShowcase.findFirst.mockResolvedValue({ ...showcaseRow, productType: ProductType.FISIK });
    await expect(
      service.createAsset('seller-1', { showcaseId: 's1', assetType: DigitalAssetType.LINK, payload: 'https://x.id/f' } as never),
    ).rejects.toThrow('bertipe DIGITAL');
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

describe('DigitalDeliveryService — audit etalase 2026-10-10 (BEC-04/05, BE-5, BES-11)', () => {
  let service: DigitalDeliveryService;
  const fileAsset = { id: 'a1', assetType: DigitalAssetType.FILE, payload: 'uploads/digital-assets/seller-1/1-x.pdf', showcaseId: 's1', sellerId: 'seller-1' };

  beforeEach(async () => {
    jest.resetAllMocks();
    mockUpload.createSignedDownloadUrl.mockReturnValue({ downloadUrl: 'https://api.test/v1/upload/s?key=k&exp=1&sig=s', expiresAt: new Date('2026-10-10T01:00:00Z') });
    const module: TestingModule = await Test.createTestingModule({
      providers: [DigitalDeliveryService, { provide: PrismaService, useValue: mockPrisma }, { provide: UploadService, useValue: mockUpload }],
    }).compile();
    service = module.get<DigitalDeliveryService>(DigitalDeliveryService);
  });

  it('BEC-05: aset FILE memverifikasi kepemilikan fileKey (purpose DIGITAL_ASSET) sebelum disimpan, consume setelahnya', async () => {
    mockPrisma.userShowcase.findFirst.mockResolvedValue(showcaseRow);
    mockPrisma.digitalAsset.create.mockResolvedValue({ id: 'a1' });
    await service.createAsset('seller-1', { showcaseId: 's1', assetType: DigitalAssetType.FILE, payload: fileAsset.payload } as never);
    expect(mockUpload.verifyUserFileKeys).toHaveBeenCalledWith('seller-1', [fileAsset.payload], UploadPurpose.DIGITAL_ASSET, expect.objectContaining({ consume: false }));
    expect(mockUpload.consumeUploadConfirmations).toHaveBeenCalledWith('seller-1', [fileAsset.payload]);
  });

  it('BEC-05: fileKey milik user lain ditolak oleh verifikasi → aset TIDAK dibuat', async () => {
    mockPrisma.userShowcase.findFirst.mockResolvedValue(showcaseRow);
    mockUpload.verifyUserFileKeys.mockRejectedValue(new Error('bukan milik Anda'));
    await expect(
      service.createAsset('seller-1', { showcaseId: 's1', assetType: DigitalAssetType.FILE, payload: 'uploads/digital-assets/other/1-x.pdf' } as never),
    ).rejects.toThrow('bukan milik');
    expect(mockPrisma.digitalAsset.create).not.toHaveBeenCalled();
  });

  it('LINK http (bukan https) ditolak', async () => {
    mockPrisma.userShowcase.findFirst.mockResolvedValue(showcaseRow);
    await expect(
      service.createAsset('seller-1', { showcaseId: 's1', assetType: DigitalAssetType.LINK, payload: 'http://x.id/f' } as never),
    ).rejects.toThrow('https');
  });

  it('BEC-04: pembeli berbayar mendapat signed URL unduhan', async () => {
    mockPrisma.digitalAsset.findFirst.mockResolvedValue(fileAsset);
    mockPrisma.order.findFirst.mockResolvedValue({ id: 'o1' });
    const out = await service.downloadAsset('buyer-1', 'a1');
    expect(out.downloadUrl).toContain('/v1/upload/s?');
    expect(mockUpload.createSignedDownloadUrl).toHaveBeenCalledWith(fileAsset.payload, 900);
    expect(mockPrisma.order.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ showcaseId: 's1', buyerId: 'buyer-1' }) }));
  });

  it('BEC-04: pembeli TANPA order berbayar → 403 (fail closed)', async () => {
    mockPrisma.digitalAsset.findFirst.mockResolvedValue(fileAsset);
    mockPrisma.order.findFirst.mockResolvedValue(null);
    await expect(service.downloadAsset('buyer-1', 'a1')).rejects.toThrow('setelah pembayaran');
    expect(mockUpload.createSignedDownloadUrl).not.toHaveBeenCalled();
  });

  it('pemilik selalu bisa mengunduh tanpa cek order; aset LINK tidak bisa diunduh', async () => {
    mockPrisma.digitalAsset.findFirst.mockResolvedValue(fileAsset);
    await service.downloadAsset('seller-1', 'a1');
    expect(mockPrisma.order.findFirst).not.toHaveBeenCalled();
    mockPrisma.digitalAsset.findFirst.mockResolvedValue({ ...fileAsset, assetType: DigitalAssetType.LINK });
    await expect(service.downloadAsset('seller-1', 'a1')).rejects.toThrow('Hanya aset FILE');
  });
});
