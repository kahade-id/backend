import { Test, TestingModule } from '@nestjs/testing';
import { ServiceBookingService } from '../services/service-booking.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { ProductType, SlotBookingStatus } from '@prisma/client';

const mockPrisma = {
  userShowcase: { findFirst: jest.fn() },
  serviceSlot: { create: jest.fn(), findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  serviceSlotBooking: { findFirst: jest.fn(), create: jest.fn(), findMany: jest.fn(), count: jest.fn(), update: jest.fn() },
  $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn({ ...mockPrisma.serviceSlotBooking })),
};

const slotRow = {
  id: 'slot1',
  showcaseId: 's1',
  capacity: 2,
  startAt: new Date(Date.now() + 86400000),
  isActive: true,
  showcase: { userId: 'seller-1', productType: ProductType.JASA },
};

describe('ServiceBookingService', () => {
  let service: ServiceBookingService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn({ ...mockPrisma.serviceSlotBooking }));
    const module: TestingModule = await Test.createTestingModule({
      providers: [ServiceBookingService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get<ServiceBookingService>(ServiceBookingService);
  });

  it('menolak slot untuk produk non-JASA', async () => {
    mockPrisma.userShowcase.findFirst.mockResolvedValue({ id: 's1', userId: 'seller-1', productType: ProductType.FISIK });
    await expect(
      service.createSlot('seller-1', { showcaseId: 's1', startAt: new Date(Date.now() + 3600000).toISOString(), endAt: new Date(Date.now() + 7200000).toISOString() } as never),
    ).rejects.toThrow('bertipe JASA');
  });

  it('menolak startAt di masa lalu', async () => {
    mockPrisma.userShowcase.findFirst.mockResolvedValue({ id: 's1', userId: 'seller-1', productType: ProductType.JASA });
    await expect(
      service.createSlot('seller-1', { showcaseId: 's1', startAt: new Date(Date.now() - 1000).toISOString(), endAt: new Date(Date.now() + 3600000).toISOString() } as never),
    ).rejects.toThrow('masa depan');
  });

  it('menolak booking ganda user yang sama (active)', async () => {
    mockPrisma.serviceSlot.findFirst.mockResolvedValue(slotRow);
    mockPrisma.serviceSlotBooking.findFirst.mockResolvedValue({ id: 'b1' });
    mockPrisma.serviceSlotBooking.count.mockResolvedValue(0);
    await expect(service.bookSlot('buyer-1', 'slot1')).rejects.toThrow('sudah memesan');
  });

  it('menolak booking saat kapasitas penuh', async () => {
    mockPrisma.serviceSlot.findFirst.mockResolvedValue(slotRow);
    mockPrisma.serviceSlotBooking.findFirst.mockResolvedValue(null);
    mockPrisma.serviceSlotBooking.count.mockResolvedValue(2); // capacity 2
    await expect(service.bookSlot('buyer-1', 'slot1')).rejects.toThrow('penuh');
  });

  it('berhasil booking bila masih ada slot', async () => {
    mockPrisma.serviceSlot.findFirst.mockResolvedValue(slotRow);
    mockPrisma.serviceSlotBooking.findFirst.mockResolvedValue(null);
    mockPrisma.serviceSlotBooking.count.mockResolvedValue(1);
    mockPrisma.serviceSlotBooking.create.mockResolvedValue({ id: 'b2', status: SlotBookingStatus.BOOKED });
    const res = await service.bookSlot('buyer-1', 'slot1');
    expect(res.status).toBe(SlotBookingStatus.BOOKED);
  });

  it('batal booking hanya oleh pemilik', async () => {
    mockPrisma.serviceSlotBooking.findFirst.mockResolvedValue(null);
    await expect(service.cancelBooking('other', 'b1')).rejects.toThrow('tidak ditemukan');
  });
});
