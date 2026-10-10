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
  // BES-06: klaim baris booking dulu (findUnique/create/updateMany), baru kapasitas.
  serviceSlotBooking: { upsert: jest.fn(), update: jest.fn(), findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
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
    // BES-10: loadBookableSlot memeriksa etalase jasa masih tayang.
    mockPrisma.userShowcase.findFirst.mockResolvedValue({ id: 's1', productType: ProductType.JASA, isActive: true });
    mockTx.serviceSlotBooking.findUnique.mockResolvedValue(null);
    mockTx.serviceSlotBooking.create.mockImplementation(async (args: any) => ({ id: 'b-new', slotId: args.data.slotId, status: SlotBookingStatus.BOOKED, createdAt: new Date() }));
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
    mockTx.serviceSlotBooking.updateMany.mockResolvedValue({ count: 1 });
    mockTx.serviceSlot.updateMany.mockResolvedValue({ count: 1 });
    const res = await service.cancelBooking('buyer-1', 'b1');
    expect(res.status).toBe(SlotBookingStatus.CANCELLED);
    expect(mockOrderStateService.cancelOrder).not.toHaveBeenCalled();
    expect(mockTx.serviceSlot.updateMany).toHaveBeenCalled();
  });

  it('P2-2: batal booking dengan order WAITING → cascade cancel order dulu', async () => {
    mockPrisma.serviceSlotBooking.findFirst.mockResolvedValue({ id: 'b1', slotId: 'slot1', orderId: 'db-o1' });
    mockPrisma.order.findUnique.mockResolvedValue({ orderId: 'ORD-1', status: 'WAITING_PAYMENT' });
    mockOrderStateService.cancelOrder.mockResolvedValue(undefined);
    mockTx.serviceSlotBooking.updateMany.mockResolvedValue({ count: 1 });
    mockTx.serviceSlot.updateMany.mockResolvedValue({ count: 1 });
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

describe('ServiceBookingService — audit etalase 2026-10-10 (BES-06/07/08/10)', () => {
  let service: ServiceBookingService;
  const activeSlot = { id: 'slot1', sellerId: 'seller-1', capacity: 2, bookedCount: 0, showcaseId: 's1' };

  beforeEach(async () => {
    jest.resetAllMocks();
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(mockTx));
    mockPrisma.userShowcase.findFirst.mockResolvedValue({ id: 's1', productType: ProductType.JASA, isActive: true });
    mockTx.serviceSlotBooking.findUnique.mockResolvedValue(null);
    mockTx.serviceSlotBooking.create.mockImplementation(async (args: any) => ({ id: 'b-new', slotId: args.data.slotId, status: SlotBookingStatus.BOOKED, createdAt: new Date() }));
    const module: TestingModule = await Test.createTestingModule({
      providers: [ServiceBookingService, { provide: PrismaService, useValue: mockPrisma }, { provide: OrdersService, useValue: mockOrdersService }, { provide: OrderStateService, useValue: mockOrderStateService }],
    }).compile();
    service = module.get<ServiceBookingService>(ServiceBookingService);
  });

  it('BES-06: baris booking diklaim DULU, kapasitas sesudahnya (urutan dalam transaksi)', async () => {
    mockPrisma.serviceSlot.findFirst.mockResolvedValue(activeSlot);
    mockPrisma.serviceSlotBooking.findUnique.mockResolvedValue(null);
    const order: string[] = [];
    mockTx.serviceSlotBooking.create.mockImplementation(async () => { order.push('create'); return { id: 'b1', slotId: 'slot1', status: SlotBookingStatus.BOOKED, createdAt: new Date() }; });
    mockTx.serviceSlot.updateMany.mockImplementation(async () => { order.push('increment'); return { count: 1 }; });
    const booking = await service.bookSlot('buyer-1', 'slot1');
    expect(booking.id).toBe('b1');
    expect(order).toEqual(['create', 'increment']);
  });

  it('BES-06: balapan — create kena unique (P2002) → 409 SLOT_ALREADY_BOOKED, kapasitas TIDAK dinaikkan', async () => {
    mockPrisma.serviceSlot.findFirst.mockResolvedValue(activeSlot);
    mockPrisma.serviceSlotBooking.findUnique.mockResolvedValue(null);
    const dup = Object.assign(new Error('dup'), { code: 'P2002' });
    Object.setPrototypeOf(dup, (await import('@prisma/client')).Prisma.PrismaClientKnownRequestError.prototype);
    mockTx.serviceSlotBooking.create.mockRejectedValue(dup);
    await expect(service.bookSlot('buyer-1', 'slot1')).rejects.toThrow('sudah booking');
    expect(mockTx.serviceSlot.updateMany).not.toHaveBeenCalled();
  });

  it('BES-06: slot penuh setelah baris dibuat → 409 SLOT_FULL (transaksi di-rollback oleh lemparan)', async () => {
    mockPrisma.serviceSlot.findFirst.mockResolvedValue(activeSlot);
    mockPrisma.serviceSlotBooking.findUnique.mockResolvedValue(null);
    mockTx.serviceSlot.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.bookSlot('buyer-1', 'slot1')).rejects.toThrow('penuh');
    expect(mockTx.serviceSlotBooking.create).toHaveBeenCalled();
  });

  it('BES-06: booking CANCELLED lama diklaim ulang lewat updateMany bersyarat (count 0 = kalah balapan)', async () => {
    mockPrisma.serviceSlot.findFirst.mockResolvedValue(activeSlot);
    mockPrisma.serviceSlotBooking.findUnique.mockResolvedValue({ id: 'b-old', status: SlotBookingStatus.CANCELLED });
    mockTx.serviceSlotBooking.findUnique.mockResolvedValue({ id: 'b-old', status: SlotBookingStatus.CANCELLED });
    mockTx.serviceSlotBooking.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.bookSlot('buyer-1', 'slot1')).rejects.toThrow('sudah booking');
    expect(mockTx.serviceSlot.updateMany).not.toHaveBeenCalled();
  });

  it('BES-07: batal ganda — transisi BOOKED→CANCELLED tidak terjadi → bookedCount TIDAK dikurangi', async () => {
    mockPrisma.serviceSlotBooking.findFirst.mockResolvedValue({ id: 'b1', slotId: 'slot1', orderId: null });
    mockTx.serviceSlotBooking.updateMany.mockResolvedValue({ count: 0 });
    await service.cancelBooking('buyer-1', 'b1');
    expect(mockTx.serviceSlot.updateMany).not.toHaveBeenCalled();
  });

  it('BES-07: batal pertama → decrement dengan guard gt 0', async () => {
    mockPrisma.serviceSlotBooking.findFirst.mockResolvedValue({ id: 'b1', slotId: 'slot1', orderId: null });
    mockTx.serviceSlotBooking.updateMany.mockResolvedValue({ count: 1 });
    mockTx.serviceSlot.updateMany.mockResolvedValue({ count: 1 });
    await service.cancelBooking('buyer-1', 'b1');
    expect(mockTx.serviceSlot.updateMany).toHaveBeenCalledWith({
      where: { id: 'slot1', bookedCount: { gt: 0 } },
      data: { bookedCount: { decrement: 1 } },
    });
  });

  it('BES-08: `from` tidak valid → 400 (bukan Invalid Date → 500)', async () => {
    await expect(service.listSlots('s1', 'kemarin')).rejects.toThrow('YYYY-MM-DD');
    expect(mockPrisma.serviceSlot.findMany).not.toHaveBeenCalled();
  });

  it('BES-08: default `from` = tengah malam WIB hari ini (slot hari ini tetap tampil setelah 07:00 WIB)', async () => {
    mockPrisma.serviceSlot.findMany.mockResolvedValue([]);
    mockPrisma.serviceSlot.count.mockResolvedValue(0);
    await service.listSlots('s1');
    const where = mockPrisma.serviceSlot.findMany.mock.calls[0][0].where;
    const gte: Date = where.slotDate.gte;
    // Tengah malam WIB = 17:00 UTC hari sebelumnya → jam UTC 17, menit 0.
    expect(gte.getUTCHours()).toBe(17);
    expect(gte.getUTCMinutes()).toBe(0);
    expect(gte.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('BES-10: slot yang tanggalnya sudah lewat ditolak', async () => {
    mockPrisma.serviceSlot.findFirst.mockResolvedValue({ ...activeSlot, slotDate: new Date('2020-01-01T00:00:00+07:00') });
    await expect(service.bookSlot('buyer-1', 'slot1')).rejects.toThrow('sudah lewat');
  });

  it('BES-10: etalase jasa nonaktif/dihapus/takedown → slot tidak bisa di-booking', async () => {
    mockPrisma.serviceSlot.findFirst.mockResolvedValue(activeSlot);
    mockPrisma.userShowcase.findFirst.mockResolvedValue(null);
    await expect(service.bookSlot('buyer-1', 'slot1')).rejects.toThrow('tidak lagi tersedia');
  });
});
