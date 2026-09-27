import { Test, TestingModule } from '@nestjs/testing';
import { PatunganService } from '../services/patungan.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { OrderStateService } from '../../orders/order-state.service';
import { PatunganMode, PatunganStatus } from '@prisma/client';

const mockPrisma = {
  patunganGroup: { create: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), update: jest.fn() },
  patunganParticipant: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), count: jest.fn(), delete: jest.fn() },
  order: { findFirst: jest.fn() },
};
const mockOrderState = { cancelOrder: jest.fn().mockResolvedValue({ ok: true }) };

const groupDto = {
  title: 'Patungan Kue Lebaran',
  targetAmountIdr: 1000000,
  deadline: new Date(Date.now() + 86400000).toISOString(),
};

describe('PatunganService', () => {
  let service: PatunganService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockOrderState.cancelOrder.mockResolvedValue({ ok: true });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PatunganService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OrderStateService, useValue: mockOrderState },
      ],
    }).compile();
    service = module.get<PatunganService>(PatunganService);
  });

  it('createGroup host otomatis jadi peserta (paid) sebesar share awal', async () => {
    mockPrisma.patunganGroup.create.mockResolvedValue({ id: 'g1', status: 'OPEN', hostId: 'h1' });
    mockPrisma.patunganParticipant.create.mockResolvedValue({ id: 'pp1' });
    const res = await service.createGroup('h1', { ...groupDto, hostContributionIdr: 250000 } as never);
    expect(res.group.status).toBe('OPEN');
    expect(mockPrisma.patunganParticipant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contributionIdr: 25000000n,
          mode: PatunganMode.BAGI_RATA,
          orderId: null,
        }),
      }),
    );
  });

  it('getGroupDetail menghitung targetReached + overfunding', async () => {
    mockPrisma.patunganGroup.findUnique.mockResolvedValue({
      id: 'g1',
      title: 'Patungan',
      targetAmount: 100000000n,
      feeIdr: 1000000n,
      feeMode: 'BAGI_RATA',
      deadline: new Date(Date.now() + 1000),
      contestEndsAt: null,
      status: PatunganStatus.OPEN,
      participants: [
        { id: 'p1', userId: 'u1', contributionIdr: 80000000n },
        { id: 'p2', userId: 'u2', contributionIdr: 30000000n },
      ],
    });
    const res = await service.getGroupDetail('g1');
    expect(res.totalCollected).toBe(1100000); // Rp1,1jt
    expect(res.targetReached).toBe(true);
    expect(res.overfunding).toBe(100000); // Rp100rb lebih
  });

  it('joinGroup menolak grup yang sudah mencapai target', async () => {
    mockPrisma.patunganGroup.findUnique.mockResolvedValue({
      id: 'g1',
      targetAmount: 100000000n,
      feeIdr: null,
      status: PatunganStatus.OPEN,
      deadline: new Date(Date.now() + 86400000),
      participants: [{ id: 'p1', userId: 'u1', contributionIdr: 100000000n }],
    });
    await expect(service.joinGroup('u2', 'g1', {})).rejects.toThrow('sudah tercapai');
  });

  it('joinGroup menolak deadline lewat', async () => {
    mockPrisma.patunganGroup.findUnique.mockResolvedValue({
      id: 'g1',
      targetAmount: 100000000n,
      feeIdr: null,
      status: PatunganStatus.OPEN,
      deadline: new Date(Date.now() - 1000),
      participants: [],
    });
    await expect(service.joinGroup('u2', 'g1', {})).rejects.toThrow('deadline');
  });

  it('initiateRelease menolak bila target belum tercapai (fail closed)', async () => {
    mockPrisma.patunganGroup.findFirst.mockResolvedValue({
      id: 'g1',
      hostId: 'h1',
      targetAmount: 100000000n,
      status: PatunganStatus.OPEN,
      deadline: new Date(Date.now() + 86400000),
      contestEndsAt: null,
      participants: [{ contributionIdr: 50000000n }],
    });
    await expect(service.initiateRelease('h1', 'g1')).rejects.toThrow('belum tercapai');
  });

  it('initiateRelease sukses → CONTESTING + contestEndsAt +24j', async () => {
    mockPrisma.patunganGroup.findFirst.mockResolvedValue({
      id: 'g1',
      hostId: 'h1',
      targetAmount: 100000000n,
      status: PatunganStatus.OPEN,
      deadline: new Date(Date.now() + 86400000),
      contestEndsAt: null,
      participants: [{ contributionIdr: 100000000n }],
    });
    mockPrisma.patunganGroup.update.mockResolvedValue({});
    const res = await service.initiateRelease('h1', 'g1');
    expect(res.status).toBe(PatunganStatus.CONTESTING);
    expect(mockPrisma.patunganGroup.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PatunganStatus.CONTESTING,
          contestEndsAt: expect.any(Date),
        }),
      }),
    );
  });

  it('linkOrder memverifikasi order berbayar milik peserta', async () => {
    mockPrisma.patunganParticipant.findFirst.mockResolvedValue({ id: 'pp1', group: { hostId: 'h1' } });
    mockPrisma.order.findFirst.mockResolvedValue({ id: 'o1', sellerId: 'h1', status: 'PROCESSING', orderValue: 10000000n });
    mockPrisma.patunganParticipant.update.mockResolvedValue({ id: 'pp1' });
    await service.linkOrder('u1', 'pp1', 'o1');
    expect(mockPrisma.patunganParticipant.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { orderId: 'o1' } }),
    );
  });
});
