/**
 * POIN 2 (2026-10-04) — unifikasi transaksi escrow.
 *
 * - create-order dari peserta jastip/patungan: order dibuat internal via
 *   OrdersService.createOrder dengan orderKind yang benar; orderId peserta
 *   terisi otomatis dalam satu transaksi DB.
 * - bookAndCreateOrder: booking jasa + order SERVICE_BOOKING; orderId booking
 *   terisi (sebelumnya tidak pernah ditulis).
 * - CommerceOrderHooks: registry multi-handler pola ChatOrderHooks.
 * - listAdminBookings: endpoint admin read-only (kontrak halaman /bookings).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { JastipService } from '../services/jastip.service';
import { PatunganService } from '../services/patungan.service';
import { ServiceBookingService } from '../services/service-booking.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { OrderStateService } from '../../orders/order-state.service';
import { OrdersService } from '../../orders/orders.service';
import { CommerceOrderHooks } from '../commerce-order-hooks';
import {
  JastipTripStatus,
  JastipParticipantStatus,
  PatunganStatus,
  PatunganParticipantStatus,
  OrderStatus,
  OrderKind,
  OrderType,
  SlotBookingStatus,
} from '@prisma/client';

const createdOrderResult = (orderId: string) => ({
  orderId,
  status: OrderStatus.WAITING_PAYMENT,
  feeCalculation: {
    feeRate: 2.5, feeAmount: 1250, buyerFeeAmount: 1250, sellerFeeAmount: 0,
    buyerPayAmount: 51250, sellerReceiveAmount: 50000,
    voucherDiscount: 0, voucherCashback: 0, membershipRankDiscount: 0,
  },
  confirmationDeadlineAt: null,
});

// ─── Jastip createOrderFromParticipant ───────────────────────────────────────

describe('JastipService.createOrderFromParticipant', () => {
  let service: JastipService;
  const mockTx: Record<string, any> = {
    jastipParticipant: { findUnique: jest.fn(), updateMany: jest.fn() },
    order: { findUnique: jest.fn() },
    $executeRawUnsafe: jest.fn(),
  };
  const mockPrisma: Record<string, any> = {
    jastipParticipant: { findFirst: jest.fn() },
    user: { findUnique: jest.fn() },
    $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(mockTx)),
  };
  const mockOrdersService = { createOrder: jest.fn() };

  const participant = {
    id: 'jp1', buyerId: 'buyer-1', orderId: null, status: JastipParticipantStatus.PRICE_LOCKED,
    itemSummary: 'Tas selempang kulit asli',
    goodsAmount: 10_000_000n, jastipFee: 1_000_000n, shippingCost: 1_500_000n,
    totalLocked: 12_500_000n, // = Rp125.000
    trip: { id: 't1', hostId: 'host-1', status: JastipTripStatus.OPEN, title: 'Trip Bangkok', orderDeadline: new Date(Date.now() + 7 * 86400000) },
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    CommerceOrderHooks.reset();
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(mockTx));
    mockTx.$executeRawUnsafe.mockResolvedValue(0);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JastipService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OrderStateService, useValue: {} },
        { provide: OrdersService, useValue: mockOrdersService },
      ],
    }).compile();
    service = module.get<JastipService>(JastipService);
  });

  it('membuat order JASTIP internal + mengisi participant.orderId dalam satu tx', async () => {
    mockPrisma.jastipParticipant.findFirst.mockResolvedValue(participant);
    mockPrisma.user.findUnique.mockResolvedValue({ username: 'host01' });
    mockOrdersService.createOrder.mockResolvedValue(createdOrderResult('ORD-J-1'));
    mockTx.jastipParticipant.findUnique.mockResolvedValue({ status: JastipParticipantStatus.PRICE_LOCKED, orderId: null });
    mockTx.order.findUnique.mockResolvedValue({ id: 'db-order-1' });
    mockTx.jastipParticipant.updateMany.mockResolvedValue({ count: 1 });

    const res = await service.createOrderFromParticipant('buyer-1', 'jp1');

    expect(mockOrdersService.createOrder).toHaveBeenCalledWith(
      'buyer-1',
      expect.objectContaining({
        role: 'BUYER',
        counterpartUsername: 'host01',
        orderType: OrderType.PHYSICAL_GOODS,
        orderKind: OrderKind.JASTIP,
        orderValue: 125000,
      }),
    );
    expect(mockTx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      'commerce_create_order:jp1',
    );
    expect(mockTx.jastipParticipant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { orderId: 'db-order-1' } }),
    );
    expect(res).toMatchObject({ participantId: 'jp1', orderId: 'ORD-J-1', orderKind: OrderKind.JASTIP });
  });

  it('menolak bila order sudah dibuat untuk peserta (conflict)', async () => {
    mockPrisma.jastipParticipant.findFirst.mockResolvedValue({ ...participant, orderId: 'db-order-9' });
    await expect(service.createOrderFromParticipant('buyer-1', 'jp1')).rejects.toBeInstanceOf(ConflictException);
    expect(mockOrdersService.createOrder).not.toHaveBeenCalled();
  });

  it('menolak bila harga belum dikunci', async () => {
    mockPrisma.jastipParticipant.findFirst.mockResolvedValue({ ...participant, status: JastipParticipantStatus.JOINED });
    await expect(service.createOrderFromParticipant('buyer-1', 'jp1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('menandai PAID saat order dibayar via CommerceOrderHooks', async () => {
    const prisma2: Record<string, any> = {
      order: { findFirst: jest.fn().mockResolvedValue({ id: 'db-order-1', status: OrderStatus.PROCESSING }) },
      jastipParticipant: { updateMany: jest.fn() },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JastipService,
        { provide: PrismaService, useValue: prisma2 },
        { provide: OrderStateService, useValue: {} },
        { provide: OrdersService, useValue: { createOrder: jest.fn() } },
      ],
    }).compile();
    const svc = module.get<JastipService>(JastipService);
    // daftarkan hook lalu emit
    CommerceOrderHooks.onOrderPaid((orderPublicId) => svc.markParticipantPaidByOrder(orderPublicId));
    CommerceOrderHooks.emitOrderPaid('ORD-J-1');
    await new Promise((r) => setImmediate(r));
    expect(prisma2.jastipParticipant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: JastipParticipantStatus.PAID } }),
    );
  });
});

// ─── Patungan createOrderFromParticipant ─────────────────────────────────────

describe('PatunganService.createOrderFromParticipant', () => {
  let service: PatunganService;
  const mockTx: Record<string, any> = {
    patunganParticipant: { findUnique: jest.fn(), updateMany: jest.fn() },
    order: { findUnique: jest.fn() },
    $executeRawUnsafe: jest.fn(),
  };
  const mockPrisma: Record<string, any> = {
    patunganParticipant: { findFirst: jest.fn() },
    user: { findUnique: jest.fn() },
    $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(mockTx)),
  };
  const mockOrdersService = { createOrder: jest.fn() };

  const participant = {
    id: 'pp1', userId: 'user-1', orderId: null, status: PatunganParticipantStatus.PENDING,
    amount: 5_000_000n, // = Rp50.000
    group: { id: 'g1', hostId: 'host-1', status: PatunganStatus.OPEN, title: 'Patungan Kopi', deadlineAt: new Date(Date.now() + 3 * 86400000) },
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    CommerceOrderHooks.reset();
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(mockTx));
    mockTx.$executeRawUnsafe.mockResolvedValue(0);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PatunganService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OrderStateService, useValue: {} },
        { provide: OrdersService, useValue: mockOrdersService },
      ],
    }).compile();
    service = module.get<PatunganService>(PatunganService);
  });

  it('membuat order PATUNGAN internal + mengisi participant.orderId', async () => {
    mockPrisma.patunganParticipant.findFirst.mockResolvedValue(participant);
    mockPrisma.user.findUnique.mockResolvedValue({ username: 'host01' });
    mockOrdersService.createOrder.mockResolvedValue(createdOrderResult('ORD-P-1'));
    mockTx.patunganParticipant.findUnique.mockResolvedValue({ status: PatunganParticipantStatus.PENDING, orderId: null });
    mockTx.order.findUnique.mockResolvedValue({ id: 'db-order-2' });
    mockTx.patunganParticipant.updateMany.mockResolvedValue({ count: 1 });

    const res = await service.createOrderFromParticipant('user-1', 'pp1');

    expect(mockOrdersService.createOrder).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ orderKind: OrderKind.PATUNGAN, orderValue: 50000, role: 'BUYER', counterpartUsername: 'host01' }),
    );
    expect(mockTx.patunganParticipant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { orderId: 'db-order-2' } }),
    );
    expect(res).toMatchObject({ participantId: 'pp1', orderId: 'ORD-P-1', orderKind: OrderKind.PATUNGAN });
  });

  it('menolak bila grup tidak OPEN', async () => {
    mockPrisma.patunganParticipant.findFirst.mockResolvedValue({
      ...participant,
      group: { ...participant.group, status: PatunganStatus.TARGET_REACHED },
    });
    await expect(service.createOrderFromParticipant('user-1', 'pp1')).rejects.toBeInstanceOf(BadRequestException);
    expect(mockOrdersService.createOrder).not.toHaveBeenCalled();
  });

  it('markParticipantPaidByOrder: PENDING → PAID + cek target tercapai', async () => {
    const tx2: Record<string, any> = {
      patunganGroup: {
        findUnique: jest.fn().mockResolvedValue({ status: PatunganStatus.OPEN, targetAmount: 5_000_000n }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      patunganParticipant: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 5_000_000n } }) },
    };
    const prisma2: Record<string, any> = {
      order: { findFirst: jest.fn().mockResolvedValue({ id: 'db-order-2', status: OrderStatus.PROCESSING }) },
      patunganParticipant: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue({ groupId: 'g1' }),
      },
      $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(tx2)),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PatunganService,
        { provide: PrismaService, useValue: prisma2 },
        { provide: OrderStateService, useValue: {} },
        { provide: OrdersService, useValue: { createOrder: jest.fn() } },
      ],
    }).compile();
    const svc = module.get<PatunganService>(PatunganService);
    await svc.markParticipantPaidByOrder('ORD-P-1');
    expect(prisma2.patunganParticipant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: PatunganParticipantStatus.PAID }) }),
    );
    expect(tx2.patunganGroup.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: PatunganStatus.TARGET_REACHED } }),
    );
  });
});

// ─── ServiceBooking bookAndCreateOrder ───────────────────────────────────────

describe('ServiceBookingService.bookAndCreateOrder', () => {
  let service: ServiceBookingService;
  const mockTx: Record<string, any> = {
    serviceSlot: { updateMany: jest.fn() },
    serviceSlotBooking: { upsert: jest.fn() },
  };
  const mockPrisma: Record<string, any> = {
    serviceSlot: { findFirst: jest.fn() },
    serviceSlotBooking: { findUnique: jest.fn(), updateMany: jest.fn() },
    userShowcase: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    order: { findUnique: jest.fn() },
    $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(mockTx)),
  };
  const mockOrdersService = { createOrder: jest.fn() };

  const slot = {
    id: 'slot-1', sellerId: 'seller-1', capacity: 5, bookedCount: 0,
    showcaseId: 's1', slotDate: new Date(Date.now() + 2 * 86400000),
    startTime: '09:00', endTime: '10:00', note: null,
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(mockTx));
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ServiceBookingService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OrdersService, useValue: mockOrdersService },
      ],
    }).compile();
    service = module.get<ServiceBookingService>(ServiceBookingService);
  });

  it('booking sukses → buat order SERVICE_BOOKING + isi booking.orderId', async () => {
    mockPrisma.serviceSlot.findFirst.mockResolvedValue(slot);
    mockPrisma.serviceSlotBooking.findUnique.mockResolvedValue(null);
    mockTx.serviceSlot.updateMany.mockResolvedValue({ count: 1 });
    mockTx.serviceSlotBooking.upsert.mockResolvedValue({ id: 'b1', slotId: 'slot-1', status: SlotBookingStatus.BOOKED });
    mockPrisma.userShowcase.findUnique.mockResolvedValue({ title: 'Cuci AC', priceMin: 5_000_000n });
    mockPrisma.user.findUnique.mockResolvedValue({ username: 'seller01' });
    mockOrdersService.createOrder.mockResolvedValue(createdOrderResult('ORD-SB-1'));
    mockPrisma.order.findUnique.mockResolvedValue({ id: 'db-order-3' });
    mockPrisma.serviceSlotBooking.updateMany.mockResolvedValue({ count: 1 });

    const res = await service.bookAndCreateOrder('buyer-1', 'slot-1', {});

    expect(mockOrdersService.createOrder).toHaveBeenCalledWith(
      'buyer-1',
      expect.objectContaining({
        role: 'BUYER',
        counterpartUsername: 'seller01',
        orderType: OrderType.SERVICE,
        orderKind: OrderKind.SERVICE_BOOKING,
        orderValue: 50000,
      }),
    );
    expect(mockPrisma.serviceSlotBooking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'b1', status: SlotBookingStatus.BOOKED, orderId: null }),
        data: { orderId: 'db-order-3' },
      }),
    );
    expect(res).toMatchObject({ bookingId: 'b1', orderId: 'ORD-SB-1', orderKind: OrderKind.SERVICE_BOOKING });
  });

  it('memakai priceIdr eksplisit bila diberikan', async () => {
    mockPrisma.serviceSlot.findFirst.mockResolvedValue(slot);
    mockPrisma.serviceSlotBooking.findUnique.mockResolvedValue(null);
    mockTx.serviceSlot.updateMany.mockResolvedValue({ count: 1 });
    mockTx.serviceSlotBooking.upsert.mockResolvedValue({ id: 'b1', slotId: 'slot-1', status: SlotBookingStatus.BOOKED });
    mockPrisma.userShowcase.findUnique.mockResolvedValue({ title: 'Cuci AC', priceMin: 5_000_000n });
    mockPrisma.user.findUnique.mockResolvedValue({ username: 'seller01' });
    mockOrdersService.createOrder.mockResolvedValue(createdOrderResult('ORD-SB-2'));
    mockPrisma.order.findUnique.mockResolvedValue({ id: 'db-order-4' });
    mockPrisma.serviceSlotBooking.updateMany.mockResolvedValue({ count: 1 });

    await service.bookAndCreateOrder('buyer-1', 'slot-1', { priceIdr: 75000 });

    expect(mockOrdersService.createOrder).toHaveBeenCalledWith(
      'buyer-1',
      expect.objectContaining({ orderValue: 75000, orderKind: OrderKind.SERVICE_BOOKING }),
    );
  });

  it('menolak bila booking sudah punya order (conflict)', async () => {
    mockPrisma.serviceSlot.findFirst.mockResolvedValue(slot);
    mockPrisma.serviceSlotBooking.findUnique.mockResolvedValue({ id: 'b1', status: SlotBookingStatus.BOOKED, orderId: 'db-old' });
    await expect(service.bookAndCreateOrder('buyer-1', 'slot-1', {})).rejects.toBeInstanceOf(ConflictException);
    expect(mockOrdersService.createOrder).not.toHaveBeenCalled();
  });

  it('menolak bila harga tidak bisa ditentukan', async () => {
    mockPrisma.serviceSlot.findFirst.mockResolvedValue(slot);
    mockPrisma.serviceSlotBooking.findUnique.mockResolvedValue(null);
    mockTx.serviceSlot.updateMany.mockResolvedValue({ count: 1 });
    mockTx.serviceSlotBooking.upsert.mockResolvedValue({ id: 'b1', slotId: 'slot-1', status: SlotBookingStatus.BOOKED });
    mockPrisma.userShowcase.findUnique.mockResolvedValue({ title: 'Cuci AC', priceMin: null });
    await expect(service.bookAndCreateOrder('buyer-1', 'slot-1', {})).rejects.toBeInstanceOf(BadRequestException);
    expect(mockOrdersService.createOrder).not.toHaveBeenCalled();
  });
});

// ─── CommerceOrderHooks ──────────────────────────────────────────────────────

describe('CommerceOrderHooks', () => {
  beforeEach(() => {
    CommerceOrderHooks.reset();
  });

  it('mendukung multi-handler dan tidak throw saat handler gagal', async () => {
    const calls: string[] = [];
    CommerceOrderHooks.onOrderPaid(async (id) => { calls.push(`h1:${id}`); });
    CommerceOrderHooks.onOrderPaid(async () => { throw new Error('boom'); });
    CommerceOrderHooks.onOrderPaid(async (id) => { calls.push(`h2:${id}`); });
    expect(() => CommerceOrderHooks.emitOrderPaid('ORD-X')).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual(['h1:ORD-X', 'h2:ORD-X']);
  });

  it('reset membersihkan handler', async () => {
    const fn = jest.fn();
    CommerceOrderHooks.onOrderPaid(fn);
    CommerceOrderHooks.reset();
    CommerceOrderHooks.emitOrderPaid('ORD-X');
    await new Promise((r) => setImmediate(r));
    expect(fn).not.toHaveBeenCalled();
  });
});

// ─── listAdminBookings ───────────────────────────────────────────────────────

describe('ServiceBookingService.listAdminBookings', () => {
  let service: ServiceBookingService;
  const mockPrisma: Record<string, any> = {
    serviceSlotBooking: { findMany: jest.fn(), count: jest.fn() },
    user: { findMany: jest.fn() },
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ServiceBookingService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OrdersService, useValue: { createOrder: jest.fn() } },
      ],
    }).compile();
    service = module.get<ServiceBookingService>(ServiceBookingService);
  });

  it('mengembalikan paginasi standar + relasi slot & user', async () => {
    const slot = { id: 'slot-1', showcaseId: 's1' };
    mockPrisma.serviceSlotBooking.findMany.mockResolvedValue([
      { id: 'b1', slotId: 'slot-1', userId: 'u1', orderId: null, status: SlotBookingStatus.BOOKED, slot },
    ]);
    mockPrisma.serviceSlotBooking.count.mockResolvedValue(1);
    mockPrisma.user.findMany.mockResolvedValue([{ id: 'u1', username: 'buyer01', fullName: 'Buyer Satu', avatarUrl: null }]);

    const res = await service.listAdminBookings(1, 20);

    expect(res).toMatchObject({ total: 1, page: 1, limit: 20 });
    expect(res.data[0]).toMatchObject({ id: 'b1', slot: { id: 'slot-1' }, user: { userId: 'u1', username: 'buyer01' } });
  });

  it('filter status diteruskan ke where', async () => {
    mockPrisma.serviceSlotBooking.findMany.mockResolvedValue([]);
    mockPrisma.serviceSlotBooking.count.mockResolvedValue(0);

    await service.listAdminBookings(1, 20, SlotBookingStatus.CANCELLED);

    expect(mockPrisma.serviceSlotBooking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: SlotBookingStatus.CANCELLED }) }),
    );
  });

  it('status tidak valid → BadRequest', async () => {
    await expect(service.listAdminBookings(1, 20, 'BOGUS' as SlotBookingStatus)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('search mencocokkan user lalu filter userId', async () => {
    mockPrisma.serviceSlotBooking.findMany.mockResolvedValue([]);
    mockPrisma.serviceSlotBooking.count.mockResolvedValue(0);
    // findMany user (search) lalu findMany user (resolve relasi)
    mockPrisma.user.findMany.mockResolvedValue([{ id: 'u9' }]);

    await service.listAdminBookings(1, 20, undefined, 'budi');

    expect(mockPrisma.serviceSlotBooking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([expect.objectContaining({ userId: { in: ['u9'] } })]),
        }),
      }),
    );
  });
});
