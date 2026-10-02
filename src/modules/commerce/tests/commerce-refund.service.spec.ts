import { Test, TestingModule } from '@nestjs/testing';
import { CommerceRefundService } from '../services/commerce-refund.service';
import { ApprovalsService } from '../../admin/approvals/approvals.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { OrderStateService } from '../../orders/order-state.service';
import { PatunganParticipantStatus, JastipParticipantStatus, OrderStatus } from '@prisma/client';

const mockPrisma: Record<string, any> = {
  patunganParticipant: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
  jastipParticipant: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
  order: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
};
const mockOrderState = { adminCancelOrder: jest.fn().mockResolvedValue(undefined) };

describe('CommerceRefundService (M2)', () => {
  let service: CommerceRefundService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockOrderState.adminCancelOrder.mockResolvedValue(undefined);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommerceRefundService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OrderStateService, useValue: mockOrderState },
        { provide: ApprovalsService, useValue: { registerExecutor: jest.fn(), propose: jest.fn() } },
      ],
    }).compile();
    service = module.get<CommerceRefundService>(CommerceRefundService);
  });

  function mockPaidParticipant(kind: 'patungan' | 'jastip', orderStatus: OrderStatus, participantStatus: any = 'REFUND_REQUIRED') {
    const delegate = kind === 'patungan' ? mockPrisma.patunganParticipant : mockPrisma.jastipParticipant;
    delegate.findUnique.mockResolvedValue({ status: participantStatus, orderId: 'order-db-1' });
    mockPrisma.order.findUnique.mockResolvedValue({ orderId: 'ORD-1', status: orderStatus });
    delegate.updateMany.mockResolvedValue({ count: 1 });
  }

  it('eksekusi refund: order PROCESSING → adminCancelOrder + peserta REFUNDED (guard predicate)', async () => {
    mockPaidParticipant('patungan', OrderStatus.PROCESSING);
    const res = await service.executeRefund('patungan', 'p1', 'admin-1', 'test');
    expect(res.outcome).toBe('REFUNDED');
    expect(mockOrderState.adminCancelOrder).toHaveBeenCalledWith('ORD-1', 'admin-1', 'test');
    expect(mockPrisma.patunganParticipant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'p1', status: PatunganParticipantStatus.REFUND_REQUIRED },
        data: { status: PatunganParticipantStatus.REFUNDED },
      }),
    );
  });

  it('idempoten: peserta sudah REFUNDED → adminCancelOrder TIDAK dipanggil', async () => {
    mockPaidParticipant('patungan', OrderStatus.PROCESSING, PatunganParticipantStatus.REFUNDED);
    const res = await service.executeRefund('patungan', 'p1', 'admin-1', 'test');
    expect(res.outcome).toBe('ALREADY_REFUNDED');
    expect(mockOrderState.adminCancelOrder).not.toHaveBeenCalled();
    expect(mockPrisma.patunganParticipant.updateMany).not.toHaveBeenCalled();
  });

  it('fail closed: order COMPLETED (dana cair) → TIDAK disentuh, status tetap REFUND_REQUIRED', async () => {
    mockPaidParticipant('jastip', OrderStatus.COMPLETED);
    const res = await service.executeRefund('jastip', 'j1', 'system', 'test');
    expect(res.outcome).toBe('SKIPPED_NOT_REFUNDABLE');
    expect(mockOrderState.adminCancelOrder).not.toHaveBeenCalled();
    expect(mockPrisma.jastipParticipant.updateMany).not.toHaveBeenCalled();
  });

  it('order sudah CANCELLED jalur lain → peserta langsung REFUNDED tanpa panggil ulang', async () => {
    mockPaidParticipant('patungan', OrderStatus.CANCELLED);
    const res = await service.executeRefund('patungan', 'p1', 'system', 'test');
    expect(res.outcome).toBe('ALREADY_REFUNDED');
    expect(mockOrderState.adminCancelOrder).not.toHaveBeenCalled();
    expect(mockPrisma.patunganParticipant.updateMany).toHaveBeenCalled();
  });

  it('peserta tanpa orderId → dilewati (fail closed, butuh manual)', async () => {
    mockPrisma.patunganParticipant.findUnique.mockResolvedValue({ status: 'REFUND_REQUIRED', orderId: null });
    const res = await service.executeRefund('patungan', 'p1', 'system', 'test');
    expect(res.outcome).toBe('SKIPPED_NO_ORDER');
    expect(mockOrderState.adminCancelOrder).not.toHaveBeenCalled();
  });

  it('executeRefundForOrder: resolve via orderId publik', async () => {
    mockPrisma.order.findFirst.mockResolvedValue({ id: 'order-db-1', orderId: 'ORD-1' });
    mockPrisma.patunganParticipant.findFirst.mockResolvedValue({ id: 'p1' });
    mockPrisma.patunganParticipant.findUnique.mockResolvedValue({ status: 'REFUND_REQUIRED', orderId: 'order-db-1' });
    mockPrisma.order.findUnique.mockResolvedValue({ orderId: 'ORD-1', status: OrderStatus.IN_DELIVERY });
    mockPrisma.patunganParticipant.updateMany.mockResolvedValue({ count: 1 });
    const res = await service.executeRefundForOrder('ORD-1', 'admin-1', 'manual');
    expect(res.outcome).toBe('REFUNDED');
    expect(mockOrderState.adminCancelOrder).toHaveBeenCalledWith('ORD-1', 'admin-1', 'manual');
  });

  it('sweepDueRefunds memproses kedua tabel dan menally hasil', async () => {
    mockPrisma.patunganParticipant.findMany.mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]);
    mockPrisma.jastipParticipant.findMany.mockResolvedValue([{ id: 'j1' }]);
    mockPrisma.patunganParticipant.findUnique
      .mockResolvedValueOnce({ status: 'REFUND_REQUIRED', orderId: 'o1' })
      .mockResolvedValueOnce({ status: 'REFUNDED', orderId: 'o2' });
    mockPrisma.jastipParticipant.findUnique.mockResolvedValue({ status: 'REFUND_REQUIRED', orderId: null });
    mockPrisma.order.findUnique.mockResolvedValue({ orderId: 'ORD-1', status: OrderStatus.PROCESSING });
    mockPrisma.patunganParticipant.updateMany.mockResolvedValue({ count: 1 });
    const counts = await service.sweepDueRefunds(50);
    expect(counts.refunded).toBe(1);
    expect(counts.already).toBe(1);
    expect(counts.skipped).toBe(1);
    expect(mockOrderState.adminCancelOrder).toHaveBeenCalledTimes(1);
  });
});
