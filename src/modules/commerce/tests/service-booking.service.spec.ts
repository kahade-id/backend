import { Test, TestingModule } from '@nestjs/testing';
import { ServiceBookingService } from '../services/service-booking.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { OrdersService } from '../../orders/orders.service';
import { OrderStateService } from '../../orders/order-state.service';
import { ProductType, SlotBookingStatus } from '@prisma/client';

const mockOrdersService = { createOrder: jest.fn() };
const mockOrderStateService = { cancelOrder: jest.fn() };

const mockTx: Record<string, any> = {
  serviceSlot: { updateMany: jest.fn(), update: jest.fn() },
  serviceSlotBooking: { upsert: jest.fn(), update: jest.fn() },
};

const mockPrisma: Record<string, any> = {
  userShowcase: { findFirst: jest.fn() },
  serviceSlot: { create: jest.fn(), findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  serviceSlotBooking: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  order: { findUnique: jest.fn() },
  $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(mockTx)),
};

const tomorrow = new Date(Date.now() + 86400000);
const slotDateStr = tomorrow.toISOString().slice(0, 10);

const jasaShowcase = { id: 's1', productType: ProductType.JASA };

describe('ServiceBookingService', () => {
  let service: ServiceBookingService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(mockTx));
    const module: TestingModule = await Test.createTestingModule({
      providers: [ServiceBookingService, { provide: PrismaService, useValue: mockPrisma }, { provide: OrdersService, useValue: mockOrdersService }, { provide: OrderStateService, useValue: mockOrderStateService }],
    }).compile();
    service = module.get<ServiceBookingService>(ServiceBookingService);
  });

  it('menolak slot untuk produk non-JASA', async () => {
    mockPrisma.userShowcase.findFirst.mockResolvedValue({ id: 's1', productType: ProductType.FISIK });
    await expect(
      service.createSlot('seller-1', { showcaseId: 's1', slotDate: slotDateStr, startTime: '09:00', endTime: '10:00' } as never),
    ).rejects.toThrow('bertipe JASA');
  });

  it('menolak slotDate di masa lalu', async () => {
    mockPrisma.userShowcase.findFirst.mockResolvedValue(jasaShowcase);
    await expect(
      service.createSlot('seller-1', { showcaseId: 's1', slotDate: '2020-01-01', startTime: '09:00', endTime: '10:00' } as never),
    ).rejects.toThrow('masa lalu');
  });

  it('menolak rentang jam tidak valid', async () => {
    mockPrisma.userShowcase.findFirst.mockResolvedValue(jasaShowcase);
    await expect(
      service.createSlot('seller-1', { showcaseId: 's1', slotDate: slotDateStr, startTime: '10:00', endTime: '09:00' } as never),
    ).rejects.toThrow('Rentang jam tidak valid');
  });

  it('menolak booking ganda user yang sama (BOOKED)', async () => {
    mockPrisma.serviceSlot.findFirst.mockResolvedValue({ id: 'slot1', sellerId: 'seller-1', capacity: 2, bookedCount: 0 });
    mockPrisma.serviceSlotBooking.findUnique.mockResolvedValue({ id: 'b1', status: SlotBookingStatus.BOOKED });
    await expect(service.bookSlot('buyer-1', 'slot1')).rejects.toThrow('sudah booking');
  });

  it('menolak booking saat kapasitas penuh', async () => {
    mockPrisma.serviceSlot.findFirst.mockResolvedValue({ id: 'slot1', sellerId: 'seller-1', capacity: 2, bookedCount: 2 });
    mockPrisma.serviceSlotBooking.findUnique.mockResolvedValue(null);
    mockTx.serviceSlot.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.bookSlot('buyer-1', 'slot1')).rejects.toThrow('penuh');
  });

  it('menolak booking oleh seller sendiri', async () => {
    mockPrisma.serviceSlot.findFirst.mockResolvedValue({ id: 'slot1', sellerId: 'seller-1', capacity: 2, bookedCount: 0 });
    await expect(service.bookSlot('seller-1', 'slot1')).rejects.toThrow('tidak bisa booking slot sendiri');
  });

  it('berhasil booking bila masih ada slot', async () => {
    mockPrisma.serviceSlot.findFirst.mockResolvedValue({ id: 'slot1', sellerId: 'seller-1', capacity: 2, bookedCount: 1 });
    mockPrisma.serviceSlotBooking.findUnique.mockResolvedValue(null);
    mockTx.serviceSlot.updateMany.mockResolvedValue({ count: 1 });
    mockTx.serviceSlotBooking.upsert.mockResolvedValue({ id: 'b2', slotId: 'slot1', status: SlotBookingStatus.BOOKED });
    const res = await service.bookSlot('buyer-1', 'slot1');
    expect(res.status).toBe(SlotBookingStatus.BOOKED);
    expect(mockTx.serviceSlot.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ bookedCount: { lt: 2 } }) }),
    );
  });

  it('batal booking hanya oleh pemilik', async () => {
    mockPrisma.serviceSlotBooking.findFirst.mockResolvedValue(null);
    await expect(service.cancelBooking('other', 'b1')).rejects.toThrow('tidak ditemukan');
  });

  it('P2-2: batal booking tanpa order tertaut → langsung batal + slot dibebaskan', async () => {
    mockPrisma.serviceSlotBooking.findFirst.mockResolvedValue({ id: 'b1', slotId: 'slot1', orderId: null });
    mockTx.serviceSlotBooking.update.mockResolvedValue({ id: 'b1' });
    mockTx.serviceSlot.update.mockResolvedValue({ id: 'slot1' });
    const res = await service.cancelBooking('buyer-1', 'b1');
    expect(res.status).toBe(SlotBookingStatus.CANCELLED);
    expect(mockOrderStateService.cancelOrder).not.toHaveBeenCalled();
  });

  it('P2-2: batal booking dengan order WAITING → cascade cancel order dulu', async () => {
    mockPrisma.serviceSlotBooking.findFirst.mockResolvedValue({ id: 'b1', slotId: 'slot1', orderId: 'db-o1' });
    mockPrisma.order.findUnique.mockResolvedValue({ orderId: 'ORD-1', status: 'WAITING_PAYMENT' });
    mockOrderStateService.cancelOrder.mockResolvedValue(undefined);
    mockTx.serviceSlotBooking.update.mockResolvedValue({ id: 'b1' });
    mockTx.serviceSlot.update.mockResolvedValue({ id: 'slot1' });
    const res = await service.cancelBooking('buyer-1', 'b1');
    expect(mockOrderStateService.cancelOrder).toHaveBeenCalledWith('ORD-1', 'buyer-1', 'OTHER', expect.any(String));
    expect(res.status).toBe(SlotBookingStatus.CANCELLED);
  });

  it('P2-2: batal booking dengan order PROCESSING → ditolak (fail closed)', async () => {
    mockPrisma.serviceSlotBooking.findFirst.mockResolvedValue({ id: 'b1', slotId: 'slot1', orderId: 'db-o1' });
    mockPrisma.order.findUnique.mockResolvedValue({ orderId: 'ORD-1', status: 'PROCESSING' });
    mockOrderStateService.cancelOrder.mockRejectedValue(new Error('Order cannot be cancelled at this stage'));
    await expect(service.cancelBooking('buyer-1', 'b1')).rejects.toThrow('tidak bisa dibatalkan');
  });
});
