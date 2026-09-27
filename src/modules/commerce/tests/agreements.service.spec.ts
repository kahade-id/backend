import { Test, TestingModule } from '@nestjs/testing';
import { AgreementsService } from '../services/agreements.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { AgreementStatus } from '@prisma/client';

const mockPrisma = {
  order: { findFirst: jest.fn() },
  orderAgreement: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
};

const orderRow = { id: 'db-o1', orderId: 'ORD-1', buyerId: 'buyer-1', sellerId: 'seller-1' };

describe('AgreementsService', () => {
  let service: AgreementsService;

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [AgreementsService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get<AgreementsService>(AgreementsService);
  });

  it('pembuat otomatis dianggap setuju', async () => {
    mockPrisma.order.findFirst.mockResolvedValue(orderRow);
    mockPrisma.orderAgreement.findUnique.mockResolvedValue(null);
    mockPrisma.orderAgreement.create.mockResolvedValue({ id: 'ag1', status: 'WAITING_COUNTERPART' });
    await service.createAgreement('seller-1', { orderId: 'ORD-1', text: 'Kesepakatan jasa desain logo yang cukup panjang.' });
    expect(mockPrisma.orderAgreement.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: AgreementStatus.WAITING_COUNTERPART,
          sellerAgreedAt: expect.any(Date),
          buyerAgreedAt: null,
        }),
      }),
    );
  });

  it('menolak SPK ganda per order', async () => {
    mockPrisma.order.findFirst.mockResolvedValue(orderRow);
    mockPrisma.orderAgreement.findUnique.mockResolvedValue({ id: 'ag1' });
    await expect(
      service.createAgreement('seller-1', { orderId: 'ORD-1', text: 'Teks kesepakatan yang cukup panjang minimal 20.' }),
    ).rejects.toThrow('sudah punya SPK');
  });

  it('tap setuju pihak kedua → AGREED', async () => {
    mockPrisma.order.findFirst.mockResolvedValue(orderRow);
    mockPrisma.orderAgreement.findUnique.mockResolvedValue({
      id: 'ag1',
      status: AgreementStatus.WAITING_COUNTERPART,
      sellerAgreedAt: new Date(),
      buyerAgreedAt: null,
    });
    mockPrisma.orderAgreement.update.mockResolvedValue({ id: 'ag1', status: 'AGREED' });
    const res = await service.agree('buyer-1', 'ORD-1');
    expect(mockPrisma.orderAgreement.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: AgreementStatus.AGREED, buyerAgreedAt: expect.any(Date) }) }),
    );
    expect(res.status).toBe('AGREED');
  });

  it('menolak tap ganda pihak yang sama', async () => {
    mockPrisma.order.findFirst.mockResolvedValue(orderRow);
    mockPrisma.orderAgreement.findUnique.mockResolvedValue({
      id: 'ag1',
      status: AgreementStatus.WAITING_COUNTERPART,
      sellerAgreedAt: new Date(),
      buyerAgreedAt: null,
    });
    await expect(service.agree('seller-1', 'ORD-1')).rejects.toThrow('sudah menyetujui');
  });

  it('bukan pihak order ditolak', async () => {
    mockPrisma.order.findFirst.mockResolvedValue(null);
    await expect(service.getAgreement('other', 'ORD-1')).rejects.toThrow('Order tidak ditemukan');
  });
});
