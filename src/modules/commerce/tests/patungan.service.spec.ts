import { Test, TestingModule } from '@nestjs/testing';
import { PatunganService } from '../services/patungan.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { OrderStateService } from '../../orders/order-state.service';
import { PatunganMode, PatunganStatus, PatunganParticipantStatus, OrderStatus } from '@prisma/client';

const mockTx: Record<string, any> = {
  patunganParticipant: { update: jest.fn(), aggregate: jest.fn(), findFirst: jest.fn() },
  patunganGroup: { update: jest.fn() },
};

const mockPrisma: Record<string, any> = {
  patunganGroup: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), update: jest.fn() },
  patunganParticipant: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), count: jest.fn(), delete: jest.fn(), aggregate: jest.fn() },
  user: { findMany: jest.fn() },
  order: { findFirst: jest.fn(), findUnique: jest.fn() },
  $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(mockTx)),
};
const mockOrderState = { cancelOrder: jest.fn().mockResolvedValue({ ok: true }) };

const groupDto = {
  title: 'Patungan Kue Lebaran',
  targetAmountIdr: 1000000,
  deadlineAt: new Date(Date.now() + 86400000).toISOString(),
  perPersonAmountIdr: 250000,
};

describe('PatunganService', () => {
  let service: PatunganService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockOrderState.cancelOrder.mockResolvedValue({ ok: true });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(mockTx));
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PatunganService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OrderStateService, useValue: mockOrderState },
      ],
    }).compile();
    service = module.get<PatunganService>(PatunganService);
  });

  it('createGroup: deadline lampau ditolak', async () => {
    await expect(
      service.createGroup('h1', { ...groupDto, deadlineAt: new Date(Date.now() - 1000).toISOString() } as never),
    ).rejects.toThrow('masa depan');
    expect(mockPrisma.patunganGroup.create).not.toHaveBeenCalled();
  });

  it('createGroup: mode bagi rata wajib perPersonAmountIdr', async () => {
    const { perPersonAmountIdr: _omit, ...dto } = groupDto;
    await expect(service.createGroup('h1', dto as never)).rejects.toThrow('perPersonAmountIdr');
  });

  it('createGroup sukses → status OPEN', async () => {
    mockPrisma.patunganGroup.create.mockResolvedValue({ id: 'g1', status: PatunganStatus.OPEN, hostId: 'h1' });
    const res = await service.createGroup('h1', groupDto as never);
    expect(res.status).toBe(PatunganStatus.OPEN);
    expect(mockPrisma.patunganGroup.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ targetAmount: 1000000_00n, mode: PatunganMode.BAGI_RATA }),
      }),
    );
  });

  it('getGroupDetail menghitung agregat + overfunding per orang', async () => {
    mockPrisma.patunganGroup.findFirst.mockResolvedValue({
      id: 'g1',
      title: 'Patungan',
      targetAmount: 100000000n, // Rp1jt
      slotTotal: 0,
      status: PatunganStatus.OPEN,
      participants: [
        { id: 'p1', userId: 'u1', amount: 80000000n, status: PatunganParticipantStatus.PAID },
        { id: 'p2', userId: 'u2', amount: 30000000n, status: PatunganParticipantStatus.PAID },
      ],
    });
    const res = await service.getGroupDetail('g1');
    expect(res.totalPaidIdr).toBe(1100000); // Rp1,1jt
    expect(res.remainingIdr).toBe(0);
    expect(res.overfundingIdr).toBe(100000); // Rp100rb lebih
    expect(res.overfundingPerPersonIdr).toBe(50000);
    expect(res.paidCount).toBe(2);
  });

  it('joinGroup menolak host join sendiri', async () => {
    mockPrisma.patunganGroup.findFirst.mockResolvedValue({
      id: 'g1', hostId: 'h1', status: PatunganStatus.OPEN,
      deadlineAt: new Date(Date.now() + 86400000), mode: PatunganMode.BAGI_RATA,
      perPersonAmount: 25000000n, targetAmount: 100000000n, slotTotal: 0,
    });
    await expect(service.joinGroup('h1', 'g1', {} as never)).rejects.toThrow('Host otomatis peserta');
  });

  it('joinGroup menolak deadline lewat', async () => {
    mockPrisma.patunganGroup.findFirst.mockResolvedValue({
      id: 'g1', hostId: 'h1', status: PatunganStatus.OPEN,
      deadlineAt: new Date(Date.now() - 1000), mode: PatunganMode.BAGI_RATA,
      perPersonAmount: 25000000n, targetAmount: 100000000n, slotTotal: 0,
    });
    await expect(service.joinGroup('u2', 'g1', {} as never)).rejects.toThrow('Deadline patungan sudah lewat');
  });

  it('joinGroup sukses (bagi rata) → PENDING', async () => {
    mockPrisma.patunganGroup.findFirst.mockResolvedValue({
      id: 'g1', hostId: 'h1', status: PatunganStatus.OPEN,
      deadlineAt: new Date(Date.now() + 86400000), mode: PatunganMode.BAGI_RATA,
      perPersonAmount: 25000000n, targetAmount: 100000000n, slotTotal: 0,
    });
    mockPrisma.patunganParticipant.create.mockResolvedValue({ id: 'pp1', status: PatunganParticipantStatus.PENDING });
    const res = await service.joinGroup('u2', 'g1', {} as never);
    expect(res.status).toBe(PatunganParticipantStatus.PENDING);
    expect(mockPrisma.patunganParticipant.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amount: 25000000n }) }),
    );
  });

  it('initiateRelease menolak bila target belum tercapai (fail closed)', async () => {
    mockPrisma.patunganGroup.findFirst.mockResolvedValue({
      id: 'g1', hostId: 'h1', targetAmount: 100000000n,
      status: PatunganStatus.OPEN, participants: [],
    });
    await expect(service.initiateRelease('h1', 'g1')).rejects.toThrow('Target belum tercapai');
  });

  it('initiateRelease sukses → CONTEST + contestEndsAt +24j', async () => {
    mockPrisma.patunganGroup.findFirst.mockResolvedValue({
      id: 'g1', hostId: 'h1', targetAmount: 100000000n,
      status: PatunganStatus.TARGET_REACHED, participants: [],
    });
    mockPrisma.patunganGroup.update.mockResolvedValue({ id: 'g1', status: PatunganStatus.CONTEST });
    const res = await service.initiateRelease('h1', 'g1');
    expect(res.status).toBe(PatunganStatus.CONTEST);
    expect(mockPrisma.patunganGroup.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: PatunganStatus.CONTEST, contestEndsAt: expect.any(Date) }),
      }),
    );
  });

  it('linkOrder memverifikasi order berbayar milik peserta', async () => {
    const participant = {
      id: 'pp1', userId: 'u1', groupId: 'g1', amount: 25000000n,
      status: PatunganParticipantStatus.PENDING,
      group: { id: 'g1', hostId: 'h1', status: PatunganStatus.OPEN, targetAmount: 100000000n },
    };
    mockPrisma.patunganParticipant.findFirst.mockResolvedValue(participant);
    mockPrisma.order.findFirst.mockResolvedValue({
      id: 'o1', buyerId: 'u1', sellerId: 'h1', orderValue: 25000000n, status: OrderStatus.PROCESSING,
    });
    mockTx.patunganParticipant.findFirst.mockResolvedValue(null);
    mockTx.patunganParticipant.update.mockResolvedValue({ ...participant, status: PatunganParticipantStatus.PAID });
    mockTx.patunganParticipant.aggregate.mockResolvedValue({ _sum: { amount: 25000000n } });
    const res = await service.linkOrder('u1', 'pp1', 'o1');
    expect(res.status).toBe(PatunganParticipantStatus.PAID);
    expect(mockTx.patunganParticipant.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ orderId: 'o1' }) }),
    );
  });

  it('linkOrder menolak order yang sudah ditautkan ke peserta lain (anti double-link)', async () => {
    const participant = {
      id: 'pp1', userId: 'u1', groupId: 'g1', amount: 25000000n,
      status: PatunganParticipantStatus.PENDING,
      group: { id: 'g1', hostId: 'h1', status: PatunganStatus.OPEN, targetAmount: 100000000n },
    };
    mockPrisma.patunganParticipant.findFirst.mockResolvedValue(participant);
    mockPrisma.order.findFirst.mockResolvedValue({
      id: 'o1', buyerId: 'u1', sellerId: 'h1', orderValue: 25000000n, status: OrderStatus.PROCESSING,
    });
    mockTx.patunganParticipant.findFirst.mockResolvedValue({ id: 'pp9' }); // peserta lain
    await expect(service.linkOrder('u1', 'pp1', 'o1')).rejects.toThrow('sudah ditautkan');
    expect(mockTx.patunganParticipant.update).not.toHaveBeenCalled();
  });

  it('linkOrder menolak order yang belum dibayar', async () => {
    const participant = {
      id: 'pp1', userId: 'u1', groupId: 'g1', amount: 25000000n,
      status: PatunganParticipantStatus.PENDING,
      group: { id: 'g1', hostId: 'h1', status: PatunganStatus.OPEN, targetAmount: 100000000n },
    };
    mockPrisma.patunganParticipant.findFirst.mockResolvedValue(participant);
    mockPrisma.order.findFirst.mockResolvedValue({
      id: 'o1', buyerId: 'u1', sellerId: 'h1', orderValue: 25000000n, status: OrderStatus.WAITING_PAYMENT,
    });
    await expect(service.linkOrder('u1', 'pp1', 'o1')).rejects.toThrow('belum dibayar');
  });

  it('listAdminGroups mengembalikan shape admin + hostName', async () => {
    mockPrisma.patunganGroup.findMany.mockResolvedValue([{
      id: 'g1', hostId: 'h1', title: 'Patungan A', description: null,
      targetAmount: 100000000n, deadlineAt: new Date('2026-12-01T00:00:00Z'),
      slotTotal: 10, mode: PatunganMode.BAGI_RATA, perPersonAmount: 25000000n,
      status: PatunganStatus.OPEN, contestEndsAt: null, releasedAt: null,
      createdAt: new Date('2026-09-28T00:00:00Z'), updatedAt: new Date('2026-09-28T00:00:00Z'),
      participants: [
        { status: PatunganParticipantStatus.PAID, amount: 25000000n },
        { status: PatunganParticipantStatus.PENDING, amount: 25000000n },
      ],
    }]);
    mockPrisma.patunganGroup.count.mockResolvedValue(1);
    mockPrisma.user.findMany.mockResolvedValue([{ id: 'h1', fullName: 'Host A' }]);
    const res = await service.listAdminGroups(1, 20);
    expect(res.total).toBe(1);
    expect(res.data[0]).toMatchObject({
      id: 'g1', hostName: 'Host A', targetAmount: 1000000, collectedAmount: 250000,
      participantCount: 2, maxParticipants: 10, status: PatunganStatus.OPEN,
    });
  });

  it('getAdminGroupDetail memetakan peserta + hostName', async () => {
    mockPrisma.patunganGroup.findFirst.mockResolvedValue({
      id: 'g1', hostId: 'h1', title: 'Patungan A', description: null,
      targetAmount: 100000000n, deadlineAt: new Date('2026-12-01T00:00:00Z'),
      slotTotal: 10, mode: PatunganMode.BAGI_RATA, perPersonAmount: 25000000n,
      status: PatunganStatus.OPEN, contestEndsAt: null, releasedAt: null,
      createdAt: new Date('2026-09-28T00:00:00Z'), updatedAt: new Date('2026-09-28T00:00:00Z'),
      participants: [{
        id: 'pp1', userId: 'u1', amount: 25000000n, orderId: 'o1',
        paidAt: new Date('2026-09-28T01:00:00Z'), status: PatunganParticipantStatus.PAID,
        createdAt: new Date('2026-09-27T00:00:00Z'),
      }],
    });
    mockPrisma.user.findMany.mockResolvedValue([
      { id: 'h1', fullName: 'Host A' },
      { id: 'u1', fullName: 'User Satu' },
    ]);
    const res = await service.getAdminGroupDetail('g1');
    expect(res.hostName).toBe('Host A');
    expect(res.participants[0]).toMatchObject({ userId: 'u1', userName: 'User Satu', hasPaid: true, amount: 250000 });
    expect(res.splitMode).toBe(PatunganMode.BAGI_RATA);
  });
});
