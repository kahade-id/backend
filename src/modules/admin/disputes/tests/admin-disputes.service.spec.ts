import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminDisputesService } from '../admin-disputes.service';
import { PrismaService } from '../../../../prisma/prisma.service';
import { WalletTxSerialService } from '../../../../common/services/wallet-tx-serial.service';
import { AuditLogService } from '../../../../common/services/audit-log.service';
import { UploadService } from '../../../upload/upload.service';
import { RealtimeService } from '../../../realtime/realtime.service';

describe('AdminDisputesService round-two boundaries', () => {
  const prisma: any = {
    dispute: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn(), updateMany: jest.fn(), findUniqueOrThrow: jest.fn() },
    adminUser: { findUnique: jest.fn(), findFirst: jest.fn() },
  };
  const auditLog = { logAdminAction: jest.fn() };
  let service: AdminDisputesService;

  beforeEach(async () => {
    jest.resetAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        AdminDisputesService,
        { provide: PrismaService, useValue: prisma },
        { provide: WalletTxSerialService, useValue: {} },
        { provide: AuditLogService, useValue: auditLog },
        { provide: UploadService, useValue: {} },
        { provide: RealtimeService, useValue: {} },
      ],
    }).compile();
    service = module.get(AdminDisputesService);
  });

  it('uses the trimmed order ID search value for every OR branch', async () => {
    prisma.dispute.findMany.mockResolvedValue([]);
    prisma.dispute.count.mockResolvedValue(0);
    await service.listDisputes(1, 20, undefined, '  ORD-123  ');
    const where = prisma.dispute.findMany.mock.calls[0][0].where;
    expect(where.OR[0].disputeId.contains).toBe('ORD-123');
    expect(where.OR[1].order.orderId.contains).toBe('ORD-123');
  });

  it('rejects an inactive or otherwise ineligible target admin before writing assignment', async () => {
    prisma.dispute.findFirst.mockResolvedValue({ id: 'disp-1', disputeId: 'D-1', status: 'OPEN' });
    prisma.adminUser.findUnique.mockResolvedValue({ role: 'SUPER_ADMIN' });
    prisma.adminUser.findFirst.mockResolvedValue(null);
    await expect(service.assignAdmin('disp-1', 'super-1', 'inactive-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.dispute.updateMany).not.toHaveBeenCalled();
  });

  it('requires an active dispute-capable role on the assignee lookup', async () => {
    prisma.dispute.findFirst.mockResolvedValue({ id: 'disp-1', disputeId: 'D-1', status: 'OPEN' });
    prisma.adminUser.findUnique.mockResolvedValue({ role: 'SUPER_ADMIN' });
    prisma.adminUser.findFirst.mockResolvedValue({ id: 'admin-2' });
    prisma.dispute.updateMany.mockResolvedValue({ count: 1 });
    prisma.dispute.findUniqueOrThrow.mockResolvedValue({ disputeId: 'D-1', status: 'ASSIGNED', assignedAdminId: 'admin-2', assignedAt: new Date() });
    await service.assignAdmin('disp-1', 'super-1', 'admin-2');
    expect(prisma.adminUser.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ isActive: true, deletedAt: null, role: { in: ['SUPER_ADMIN', 'DISPUTE_ADMIN'] } }),
    }));
  });

  void BadRequestException;
});
