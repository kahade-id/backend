import { BadRequestException } from '@nestjs/common';
import { AdminReportsService } from '../admin-reports.service';

describe('AdminReportsService state transitions', () => {
  const prisma = {
    userReport: { findUnique: jest.fn(), updateMany: jest.fn() },
  };
  const auditLog = { logAdminAction: jest.fn() };
  let service: AdminReportsService;

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.userReport.updateMany.mockResolvedValue({ count: 1 });
    service = new AdminReportsService(prisma as never, auditLog as never);
  });

  it('uses a conditional status update for resolve', async () => {
    prisma.userReport.findUnique.mockResolvedValue({ id: 'creport123456789012345678', status: 'PENDING' });
    await expect(service.resolveReport('creport123456789012345678', 'Action taken', 'admin-1', '127.0.0.1'))
      .resolves.toMatchObject({ reportId: 'creport123456789012345678' });
    expect(prisma.userReport.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'creport123456789012345678', status: { in: ['PENDING', 'UNDER_REVIEW'] } },
    }));
  });

  it('rejects resolve when the conditional update loses a race', async () => {
    prisma.userReport.findUnique.mockResolvedValue({ id: 'creport123456789012345678', status: 'PENDING' });
    prisma.userReport.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.resolveReport('creport123456789012345678', 'Action taken', 'admin-1', '127.0.0.1'))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(auditLog.logAdminAction).not.toHaveBeenCalled();
  });

  it('rejects dismiss when the conditional update loses a race', async () => {
    prisma.userReport.findUnique.mockResolvedValue({ id: 'creport123456789012345678', status: 'UNDER_REVIEW' });
    prisma.userReport.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.dismissReport('creport123456789012345678', 'admin-1', '127.0.0.1'))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(auditLog.logAdminAction).not.toHaveBeenCalled();
  });

  it('BAI-127: dismiss stores the admin notes in `resolution` + audit log (no longer silently dropped)', async () => {
    prisma.userReport.findUnique.mockResolvedValue({ id: 'creport123456789012345678', status: 'PENDING' });

    await expect(
      service.dismissReport('creport123456789012345678', 'admin-1', '127.0.0.1', 'Laporan tidak terbukti'),
    ).resolves.toMatchObject({ reportId: 'creport123456789012345678' });

    expect(prisma.userReport.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'DISMISSED',
          resolution: 'Laporan tidak terbukti',
        }),
      }),
    );
    expect(auditLog.logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('Laporan tidak terbukti'),
      }),
    );
  });

  it('BAI-127: dismiss without notes stores resolution=null', async () => {
    prisma.userReport.findUnique.mockResolvedValue({ id: 'creport123456789012345678', status: 'PENDING' });

    await service.dismissReport('creport123456789012345678', 'admin-1', '127.0.0.1');

    expect(prisma.userReport.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ resolution: null }),
      }),
    );
  });
});
