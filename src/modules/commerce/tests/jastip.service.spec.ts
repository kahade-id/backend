import { Test, TestingModule } from '@nestjs/testing';
import { JastipService } from '../services/jastip.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { OrderStateService } from '../../orders/order-state.service';
import { JastipTripStatus, JastipParticipantStatus, OrderStatus } from '@prisma/client';

const mockTx: Record<string, any> = {
  jastipTrip: { updateMany: jest.fn(), update: jest.fn() },
  jastipParticipant: { create: jest.fn(), update: jest.fn() },
};

const mockPrisma: Record<string, any> = {
  jastipTrip: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), count: jest.fn() },
  jastipItem: { create: jest.fn(), findMany: jest.fn() },
  jastipParticipant: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  order: { findFirst: jest.fn(), findUnique: jest.fn() },
  $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(mockTx)),
};
const mockOrderState = { cancelOrder: jest.fn().mockResolvedValue({ ok: true }) };

const futureDto = {
  title: 'Trip Jakarta',
  destinationCity: 'Jakarta',
  orderDeadline: new Date(Date.now() + 86400000).toISOString(),
};

const priceDto = { goodsAmountIdr: 100000, jastipFeeIdr: 10000, shippingCostIdr: 15000 };

describe('JastipService', () => {
  let service: JastipService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockOrderState.cancelOrder.mockResolvedValue({ ok: true });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(mockTx));
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JastipService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OrderStateService, useValue: mockOrderState },
      ],
    }).compile();
    service = module.get<JastipService>(JastipService);
  });

  it('createTrip dimulai sebagai DRAFT', async () => {
    mockPrisma.jastipTrip.create.mockResolvedValue({ id: 't1', status: JastipTripStatus.DRAFT });
    const res = await service.createTrip('host-1', futureDto as never);
    expect(mockPrisma.jastipTrip.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: JastipTripStatus.DRAFT, hostId: 'host-1' }) }),
    );
    expect(res.status).toBe(JastipTripStatus.DRAFT);
  });

  it('createTrip menolak deadline lampau', async () => {
    await expect(
      service.createTrip('host-1', { ...futureDto, orderDeadline: new Date(Date.now() - 1000).toISOString() } as never),
    ).rejects.toThrow('masa depan');
  });

  it('openTrip hanya dari DRAFT', async () => {
    mockPrisma.jastipTrip.findFirst.mockResolvedValue({ id: 't1', hostId: 'host-1', status: JastipTripStatus.OPEN, participants: [] });
    await expect(service.openTrip('host-1', 't1')).rejects.toThrow('DRAFT');
  });

  it('lockPrice: peserta tidak ditemukan → 404', async () => {
    mockPrisma.jastipParticipant.findFirst.mockResolvedValue(null);
    await expect(service.lockPrice('host-1', 'p1', priceDto as never)).rejects.toThrow('Peserta tidak ditemukan');
  });

  it('lockPrice oleh non-host ditolak', async () => {
    mockPrisma.jastipParticipant.findFirst.mockResolvedValue({
      id: 'p1', status: JastipParticipantStatus.JOINED, trip: { hostId: 'host-1', status: JastipTripStatus.OPEN },
    });
    await expect(service.lockPrice('other', 'p1', priceDto as never)).rejects.toThrow('Hanya host');
  });

  it('lockPrice hanya sekali (status harus JOINED)', async () => {
    mockPrisma.jastipParticipant.findFirst.mockResolvedValue({
      id: 'p1', status: JastipParticipantStatus.PRICE_LOCKED, trip: { hostId: 'host-1', status: JastipTripStatus.OPEN },
    });
    await expect(service.lockPrice('host-1', 'p1', priceDto as never)).rejects.toThrow('JOINED');
  });

  it('lockPrice sukses → PRICE_LOCKED + total terkunci', async () => {
    mockPrisma.jastipParticipant.findFirst.mockResolvedValue({
      id: 'p1', status: JastipParticipantStatus.JOINED, trip: { hostId: 'host-1', status: JastipTripStatus.OPEN },
    });
    mockPrisma.jastipParticipant.update.mockResolvedValue({ id: 'p1', status: JastipParticipantStatus.PRICE_LOCKED });
    const res = await service.lockPrice('host-1', 'p1', priceDto as never);
    expect(res.status).toBe(JastipParticipantStatus.PRICE_LOCKED);
    expect(mockPrisma.jastipParticipant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ totalLocked: 125000_00n, status: JastipParticipantStatus.PRICE_LOCKED }),
      }),
    );
  });

  it('linkOrder memverifikasi order berbayar milik buyer (nilai = total terkunci)', async () => {
    mockPrisma.jastipParticipant.findFirst.mockResolvedValue({
      id: 'p1', buyerId: 'buyer-1', status: JastipParticipantStatus.PRICE_LOCKED, totalLocked: 125000_00n,
      trip: { hostId: 'host-1' },
    });
    mockPrisma.order.findFirst.mockResolvedValue({
      id: 'o1', buyerId: 'buyer-1', sellerId: 'host-1', status: OrderStatus.PROCESSING, orderValue: 125000_00n,
    });
    mockPrisma.jastipParticipant.update.mockResolvedValue({ id: 'p1', status: JastipParticipantStatus.PAID });
    const res = await service.linkOrder('buyer-1', 'p1', { orderId: 'o1' } as never);
    expect(res.status).toBe(JastipParticipantStatus.PAID);
  });

  it('linkOrder menolak bila harga belum dikunci', async () => {
    mockPrisma.jastipParticipant.findFirst.mockResolvedValue({
      id: 'p1', buyerId: 'buyer-1', status: JastipParticipantStatus.JOINED, trip: { hostId: 'host-1' },
    });
    await expect(service.linkOrder('buyer-1', 'p1', { orderId: 'o1' } as never)).rejects.toThrow('belum dikunci');
  });

  it('linkOrder menolak order non-berbayar', async () => {
    mockPrisma.jastipParticipant.findFirst.mockResolvedValue({
      id: 'p1', buyerId: 'buyer-1', status: JastipParticipantStatus.PRICE_LOCKED, totalLocked: 125000_00n,
      trip: { hostId: 'host-1' },
    });
    mockPrisma.order.findFirst.mockResolvedValue({
      id: 'o1', buyerId: 'buyer-1', sellerId: 'host-1', status: OrderStatus.WAITING_PAYMENT, orderValue: 125000_00n,
    });
    await expect(service.linkOrder('buyer-1', 'p1', { orderId: 'o1' } as never)).rejects.toThrow('belum dibayar');
  });

  it('failTrip: peserta PAID tanpa order → REFUND_REQUIRED (fail closed)', async () => {
    mockPrisma.jastipTrip.findFirst.mockResolvedValue({
      id: 't1', hostId: 'host-1', status: JastipTripStatus.OPEN,
      participants: [{ id: 'p1', status: JastipParticipantStatus.PAID, orderId: null }],
    });
    mockPrisma.jastipTrip.update.mockResolvedValue({});
    mockPrisma.jastipParticipant.update.mockResolvedValue({});
    const res = await service.failTrip('host-1', 't1');
    expect(res.status).toBe(JastipTripStatus.CANCELLED);
    expect(res.results[0].outcome).toBe('REFUND_REQUIRED');
  });

  it('failTrip: order masih cancellable → di-cancel via OrderStateService', async () => {
    mockPrisma.jastipTrip.findFirst.mockResolvedValue({
      id: 't1', hostId: 'host-1', status: JastipTripStatus.OPEN,
      participants: [{ id: 'p1', status: JastipParticipantStatus.PAID, orderId: 'oid1' }],
    });
    mockPrisma.jastipTrip.update.mockResolvedValue({});
    mockPrisma.order.findUnique.mockResolvedValue({ orderId: 'ORD-1', status: OrderStatus.WAITING_PAYMENT });
    mockPrisma.jastipParticipant.update.mockResolvedValue({});
    const res = await service.failTrip('host-1', 't1', 'barang habis');
    expect(mockOrderState.cancelOrder).toHaveBeenCalled();
    expect(res.results[0].outcome).toBe('REFUNDED');
  });
});
