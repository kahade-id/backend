import { Test, TestingModule } from '@nestjs/testing';
import { DisputeQuickEscalationService } from '../dispute-quick-escalation.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { DisputeStatus } from '@prisma/client';

const mockPrisma = {
  dispute: { findFirst: jest.fn(), updateMany: jest.fn() },
  adminAuditLog: { create: jest.fn().mockResolvedValue({}) },
  notification: { create: jest.fn().mockResolvedValue({}) },
  emitNotificationCreated: jest.fn(),
};

describe('DisputeQuickEscalationService', () => {
  let service: DisputeQuickEscalationService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockPrisma.adminAuditLog.create.mockResolvedValue({});
    mockPrisma.notification.create.mockResolvedValue({});
    const module: TestingModule = await Test.createTestingModule({
      providers: [DisputeQuickEscalationService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get<DisputeQuickEscalationService>(DisputeQuickEscalationService);
  });

  it('berhasil eskalasi 1 ketuk (OPEN → ESCALATED)', async () => {
    mockPrisma.dispute.findFirst.mockResolvedValue({
      id: 'd1',
      disputeId: 'DSP-1',
      status: DisputeStatus.OPEN,
      order: { buyerId: 'b1', sellerId: 's1' },
    });
    mockPrisma.dispute.updateMany.mockResolvedValue({ count: 1 });
    const res = await service.quickEscalate('admin-1', 'd1');
    expect(res.status).toBe(DisputeStatus.ESCALATED);
    expect(mockPrisma.dispute.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: expect.arrayContaining([DisputeStatus.OPEN]) },
        }),
        data: expect.objectContaining({ assignedAdminId: 'admin-1' }),
      }),
    );
  });

  it('menolak dispute yang sudah ESCALATED', async () => {
    mockPrisma.dispute.findFirst.mockResolvedValue({
      id: 'd1',
      disputeId: 'DSP-1',
      status: DisputeStatus.ESCALATED,
      order: { buyerId: 'b1', sellerId: 's1' },
    });
    await expect(service.quickEscalate('admin-1', 'd1')).rejects.toThrow('sudah ESCALATED');
  });

  it('menolak dispute yang sudah RESOLVED', async () => {
    mockPrisma.dispute.findFirst.mockResolvedValue({
      id: 'd1',
      disputeId: 'DSP-1',
      status: DisputeStatus.RESOLVED,
      order: { buyerId: 'b1', sellerId: 's1' },
    });
    await expect(service.quickEscalate('admin-1', 'd1')).rejects.toThrow('sudah RESOLVED');
  });

  it('fail closed bila race: updateMany count=0 → INVALID_STATUS', async () => {
    mockPrisma.dispute.findFirst.mockResolvedValue({
      id: 'd1',
      disputeId: 'DSP-1',
      status: DisputeStatus.OPEN,
      order: { buyerId: 'b1', sellerId: 's1' },
    });
    mockPrisma.dispute.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.quickEscalate('admin-1', 'd1')).rejects.toThrow('tidak bisa dieskalasi');
  });

  it('menulis adminAuditLog', async () => {
    mockPrisma.dispute.findFirst.mockResolvedValue({
      id: 'd1',
      disputeId: 'DSP-1',
      status: DisputeStatus.OPEN,
      order: { buyerId: 'b1', sellerId: 's1' },
    });
    mockPrisma.dispute.updateMany.mockResolvedValue({ count: 1 });
    await service.quickEscalate('admin-1', 'd1', 'prioritas');
    expect(mockPrisma.adminAuditLog.create).toHaveBeenCalled();
  });
});
