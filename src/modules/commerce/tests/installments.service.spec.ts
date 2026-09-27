import { Test, TestingModule } from '@nestjs/testing';
import { InstallmentsService } from '../services/installments.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { MilestonesService } from '../../milestones/milestones.service';

const mockPrisma = {
  order: { findFirst: jest.fn() },
};
const mockMilestones = {
  createMilestones: jest.fn().mockResolvedValue({ ok: true }),
};

const orderRow = {
  id: 'db-order-1',
  orderId: 'ORD-20260101-001',
  sellerId: 'seller-1',
  buyerId: 'buyer-1',
  orderValue: 100000000n, // Rp1.000.000
  title: 'Jasa desain',
};

describe('InstallmentsService', () => {
  let service: InstallmentsService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockMilestones.createMilestones.mockResolvedValue({ ok: true });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InstallmentsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: MilestonesService, useValue: mockMilestones },
      ],
    }).compile();
    service = module.get<InstallmentsService>(InstallmentsService);
  });

  it('menolak tanpa opt-in agreed=true', async () => {
    await expect(
      service.createInstallmentPlan('seller-1', 'ORD-1', { dpPercent: 30, installmentCount: 3, agreed: false }),
    ).rejects.toThrow('opt-in');
  });

  it('menolak bila pemanggil bukan seller', async () => {
    mockPrisma.order.findFirst.mockResolvedValue(orderRow);
    await expect(
      service.createInstallmentPlan('other', 'ORD-1', { dpPercent: 30, installmentCount: 3, agreed: true }),
    ).rejects.toThrow('Hanya seller');
  });

  it('menyusun DP 30% + 3 cicilan dengan total tepat', async () => {
    mockPrisma.order.findFirst.mockResolvedValue(orderRow);
    await service.createInstallmentPlan('seller-1', 'ORD-1', { dpPercent: 30, installmentCount: 3, agreed: true, intervalDays: 30 });
    expect(mockMilestones.createMilestones).toHaveBeenCalledWith(
      'db-order-1',
      'seller-1',
      expect.objectContaining({ milestones: expect.any(Array) }),
    );
    const dto = mockMilestones.createMilestones.mock.calls[0][2];
    expect(dto.milestones).toHaveLength(4); // DP + 3 cicilan
    expect(dto.milestones[0].title).toBe('DP 30%');
    expect(dto.milestones[0].amountIdr).toBe(300000);
    const total = dto.milestones.reduce((a: number, m: { amountIdr: number }) => a + m.amountIdr, 0);
    expect(total).toBe(1000000);
  });

  it('tanpa DP: N cicilan langsung, total tepat', async () => {
    mockPrisma.order.findFirst.mockResolvedValue(orderRow);
    await service.createInstallmentPlan('seller-1', 'ORD-1', { dpPercent: 0, installmentCount: 2, agreed: true });
    const dto = mockMilestones.createMilestones.mock.calls[0][2];
    expect(dto.milestones).toHaveLength(2);
    const total = dto.milestones.reduce((a: number, m: { amountIdr: number }) => a + m.amountIdr, 0);
    expect(total).toBe(1000000);
  });

  it('menolak skema 1 tahap (butuh minimal 2)', async () => {
    mockPrisma.order.findFirst.mockResolvedValue(orderRow);
    await expect(
      service.createInstallmentPlan('seller-1', 'ORD-1', { dpPercent: 0, installmentCount: 1, agreed: true }),
    ).rejects.toThrow('minimal 2 tahap');
  });
});
