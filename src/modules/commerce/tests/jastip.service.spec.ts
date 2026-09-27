import { Test, TestingModule } from '@nestjs/testing';
import { JastipService } from '../services/jastip.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { OrderStateService } from '../../orders/order-state.service';
import { JastipTripStatus, JastipParticipantStatus, OrderStatus } from '@prisma/client';

const mockPrisma = {
  jastipTrip: { create: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), count: jest.fn() },
  jastipItem: { create: jest.fn(), findMany: jest.fn() },
  jastipParticipant: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  order: { findFirst: jest.fn() },
};
const mockOrderState = { cancelOrder: jest.fn().mockResolvedValue({ ok: true }) };

const futureDto = {
  title: 'Trip Jakarta',
  originCity: 'Jakarta',
  orderDeadline: new Date(Date.now() + 86400000).toISOString(),
};

describe('JastipService', () => {
  let service: JastipService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockOrderState.cancelOrder.mockResolvedValue({ ok: true });
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
    mockPrisma.jastipTrip.create.mockResolvedValue({ id: 't1', status: 'DRAFT' });
    const res = await service.createTrip('host-1', futureDto as never);
    expect(mockPrisma.jastipTrip.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: JastipTripStatus.DRAFT, hostId: 'host-1' }) }),
    );
    expect(res.status).toBe('DRAFT');
  });

  it('lockPrice hanya oleh host & setelah join (REQUESTED→PRICE_LOCKED)', async () => {
    mockPrisma.jastipParticipant.findFirst.mockResolvedValue(null);
    await expect(
      service.lockPrice('host-1', 'p1', { itemPriceIdr: 100000, feeIdr: 10000 } as never),
    ).rejects.toThrow('Partisipasi tidak ditemukan');
  });

  it('lockPrice oleh non-host ditolak', async () => {
    mockPrisma.jastipParticipant.findFirst.mockResolvedValue({ id: 'p1', status: JastipParticipantStatus.REQUESTED, trip: { hostId: 'host-1' } });
    await expect(
      service.lockPrice('other', 'p1', { itemPriceIdr: 100000, feeIdr: 10000 } as never),
    ).rejects.toThrow('Hanya host');
  });

  it('lockPrice: buyer belum join ulang ditolak', async () => {
    mockPrisma.jastipParticipant.findFirst.mockResolvedValue({
      id: 'p1', status: JastipParticipantStatus.PRICE_LOCKED, trip: { hostId: 'host-1' },
    });
    await expect(
      service.lockPrice('host-1', 'p1', { itemPriceIdr: 100000, feeIdr: 10000 } as never),
    ).rejects.toThrow('REQUESTED');
  });

  it('linkOrder memverifikasi order berbayar milik buyer', async () => {
    mockPrisma.jastipParticipant.findFirst.mockResolvedValue({
      id: 'p1', status: JastipParticipantStatus.PRICE_LOCKED, totalPriceIdr: null,
      trip: { hostId: 'host-1' },
    });
    mockPrisma.order.findFirst.mockResolvedValue({
      id: 'o1', buyerId: 'buyer-1', sellerId: 'host-1', status: OrderStatus.PROCESSING, orderValue: 11000000n,
    });
    mockPrisma.jastipParticipant.update.mockResolvedValue({ id: 'p1', status: 'PAID' });
    const res = await service.linkOrder('buyer-1', 'p1', { orderId: 'o1' });
    expect(res.status).toBe('PAID');
  });

  it('linkOrder menolak order non-berbayar', async () => {
    mockPrisma.jastipParticipant.findFirst.mockResolvedValue({
      id: 'p1', status: JastipParticipantStatus.PRICE_LOCKED, totalPriceIdr: null,
      trip: { hostId: 'host-1' },
    });
    mockPrisma.order.findFirst.mockResolvedValue(null);
    await expect(service.linkOrder('buyer-1', 'p1', { orderId: 'o1' })).rejects.toThrow('tidak memenuhi syarat');
  });

  it('failTrip: peserta PAID tanpa order → REFUND_REQUIRED (fail closed)', async () => {
    mockPrisma.jastipTrip.findFirst.mockResolvedValue({ id: 't1', hostId: 'host-1' });
    mockPrisma.jastipParticipant.findMany.mockResolvedValue([
      { id: 'p1', orderId: null },
    ]);
    mockPrisma.jastipParticipant.update.mockResolvedValue({});
    mockPrisma.jastipTrip.update.mockResolvedValue({});
    const res = await service.failTrip('host-1', 't1');
    expect(res.results[0].action).toBe('REFUND_REQUIRED');
  });
});
