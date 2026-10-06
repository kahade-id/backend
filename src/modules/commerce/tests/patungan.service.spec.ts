import { Test, TestingModule } from '@nestjs/testing';
import { PatunganService } from '../services/patungan.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { OrderStateService } from '../../orders/order-state.service';
import { OrdersService } from '../../orders/orders.service';
import { PatunganMode, PatunganStatus, PatunganParticipantStatus, OrderStatus } from '@prisma/client';

const mockTx: Record<string, any> = {
  patunganParticipant: { update: jest.fn(), updateMany: jest.fn(), aggregate: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn(), create: jest.fn() },
  patunganGroup: { update: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn() },
  jastipParticipant: { findFirst: jest.fn() },
  order: { count: jest.fn() },
  dispute: { count: jest.fn() },
  $executeRawUnsafe: jest.fn(),
  $queryRaw: jest.fn(),
};

const mockPrisma: Record<string, any> = {
  patunganGroup: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  patunganParticipant: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn(), delete: jest.fn(), deleteMany: jest.fn(), aggregate: jest.fn() },
  user: { findMany: jest.fn() },
  order: { findFirst: jest.fn(), findUnique: jest.fn() },
  $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(mockTx)),
};
const mockOrderState = { cancelOrder: jest.fn().mockResolvedValue({ ok: true }) };
const mockOrdersService = { createOrder: jest.fn() };

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
    mockTx.$executeRawUnsafe.mockResolvedValue(0);
    // P2-5 repair sweep: default tidak ada peserta PAID yang stuck di grup FAILED.
    mockPrisma.patunganParticipant.findMany.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PatunganService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OrderStateService, useValue: mockOrderState },
        { provide: OrdersService, useValue: mockOrdersService },
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
    mockTx.patunganGroup.findFirst.mockResolvedValue({
      id: 'g1', hostId: 'h1', status: PatunganStatus.OPEN,
      deadlineAt: new Date(Date.now() + 86400000), mode: PatunganMode.BAGI_RATA,
      perPersonAmount: 25000000n, targetAmount: 100000000n, slotTotal: 0,
    });
    await expect(service.joinGroup('h1', 'g1', {} as never)).rejects.toThrow('Host otomatis peserta');
  });

  it('joinGroup menolak deadline lewat', async () => {
    mockTx.patunganGroup.findFirst.mockResolvedValue({
      id: 'g1', hostId: 'h1', status: PatunganStatus.OPEN,
      deadlineAt: new Date(Date.now() - 1000), mode: PatunganMode.BAGI_RATA,
      perPersonAmount: 25000000n, targetAmount: 100000000n, slotTotal: 0,
    });
    await expect(service.joinGroup('u2', 'g1', {} as never)).rejects.toThrow('Deadline patungan sudah lewat');
  });

  it('joinGroup sukses (bagi rata) → PENDING', async () => {
    mockTx.patunganGroup.findFirst.mockResolvedValue({
      id: 'g1', hostId: 'h1', status: PatunganStatus.OPEN,
      deadlineAt: new Date(Date.now() + 86400000), mode: PatunganMode.BAGI_RATA,
      perPersonAmount: 25000000n, targetAmount: 100000000n, slotTotal: 0,
    });
    mockTx.patunganParticipant.create.mockResolvedValue({ id: 'pp1', status: PatunganParticipantStatus.PENDING });
    const res = await service.joinGroup('u2', 'g1', {} as never);
    expect(res!.status).toBe(PatunganParticipantStatus.PENDING);
    expect(mockTx.patunganParticipant.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amount: 25000000n }) }),
    );
  });

  // LOW (SEC-B ronde 2): orderId DIHAPUS dari JoinPatunganDto — penautan order
  // WAJIB via linkOrder. Penolakan field asing diuji di
  // commerce-dto-validation.spec.ts (forbidNonWhitelisted).
  it('LOW: joinGroup tidak pernah menyimpan orderId (create selalu orderId: null)', async () => {
    mockTx.patunganGroup.findFirst.mockResolvedValue({
      id: 'g1', hostId: 'h1', status: PatunganStatus.OPEN,
      deadlineAt: new Date(Date.now() + 86400000), mode: PatunganMode.BAGI_RATA,
      perPersonAmount: 25000000n, targetAmount: 100000000n, slotTotal: 0,
    });
    mockTx.patunganParticipant.create.mockResolvedValue({ id: 'pp1', status: PatunganParticipantStatus.PENDING, orderId: null });
    await service.joinGroup('u2', 'g1', {} as never);
    expect(mockTx.patunganParticipant.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ orderId: null }) }),
    );
  });

  it('LOW: joinGroup slot penuh ditolak; hitungan di bawah row lock grup', async () => {
    mockTx.patunganGroup.findFirst.mockResolvedValue({
      id: 'g1', hostId: 'h1', status: PatunganStatus.OPEN,
      deadlineAt: new Date(Date.now() + 86400000), mode: PatunganMode.BAGI_RATA,
      perPersonAmount: 25000000n, targetAmount: 100000000n, slotTotal: 2,
    });
    mockTx.patunganParticipant.count.mockResolvedValue(2);
    await expect(service.joinGroup('u2', 'g1', {} as never)).rejects.toThrow('Slot grup penuh');
    // Wave 2: row lock eksplisit SELECT ... FOR UPDATE (bukan update kosong).
    expect(mockTx.$queryRaw).toHaveBeenCalled();
    const rawSql = String(mockTx.$queryRaw.mock.calls[0][0]?.strings?.join(' ') ?? mockTx.$queryRaw.mock.calls[0][0]);
    expect(rawSql).toMatch(/FOR UPDATE/i);
    expect(mockTx.patunganParticipant.create).not.toHaveBeenCalled();
  });

  it('Wave 2: joinGroup mengunci baris grup SEBELUM menghitung slot (urutan lock → count → create)', async () => {
    mockTx.patunganGroup.findFirst.mockResolvedValue({
      id: 'g1', hostId: 'h1', status: PatunganStatus.OPEN,
      deadlineAt: new Date(Date.now() + 86400000), mode: PatunganMode.BAGI_RATA,
      perPersonAmount: 25000000n, targetAmount: 100000000n, slotTotal: 5,
    });
    mockTx.patunganParticipant.count.mockResolvedValue(3);
    mockTx.patunganParticipant.create.mockResolvedValue({ id: 'pp1', status: PatunganParticipantStatus.PENDING });
    await service.joinGroup('u2', 'g1', {} as never);
    const order = mockTx.$queryRaw.mock.invocationCallOrder[0];
    expect(order).toBeLessThan(mockTx.patunganParticipant.count.mock.invocationCallOrder[0]);
    expect(order).toBeLessThan(mockTx.patunganParticipant.create.mock.invocationCallOrder[0]);
    expect(mockTx.patunganParticipant.create).toHaveBeenCalled();
  });

  it('initiateRelease menolak bila target belum tercapai (fail closed)', async () => {
    mockPrisma.patunganGroup.findFirst.mockResolvedValue({
      id: 'g1', hostId: 'h1', targetAmount: 100000000n,
      status: PatunganStatus.OPEN, participants: [],
    });
    await expect(service.initiateRelease('h1', 'g1')).rejects.toThrow('Target belum tercapai');
  });

  it('initiateRelease sukses → CONTEST + contestEndsAt +24j (predicate TARGET_REACHED)', async () => {
    mockPrisma.patunganGroup.findFirst.mockResolvedValue({
      id: 'g1', hostId: 'h1', targetAmount: 100000000n,
      status: PatunganStatus.TARGET_REACHED, participants: [],
    });
    mockPrisma.patunganGroup.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.patunganGroup.findUnique.mockResolvedValue({ id: 'g1', status: PatunganStatus.CONTEST });
    const res = await service.initiateRelease('h1', 'g1');
    expect(res!.status).toBe(PatunganStatus.CONTEST);
    expect(mockPrisma.patunganGroup.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'g1', status: PatunganStatus.TARGET_REACHED }),
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
    mockTx.jastipParticipant.findFirst.mockResolvedValue(null);
    mockTx.patunganParticipant.updateMany.mockResolvedValue({ count: 1 });
    mockTx.patunganGroup.findUnique.mockResolvedValue({ status: PatunganStatus.OPEN, targetAmount: 100000000n });
    mockTx.patunganParticipant.aggregate.mockResolvedValue({ _sum: { amount: 25000000n } });
    mockTx.patunganParticipant.findUnique.mockResolvedValue({ ...participant, status: PatunganParticipantStatus.PAID });
    const res = await service.linkOrder('u1', 'pp1', 'o1');
    expect(res!.status).toBe(PatunganParticipantStatus.PAID);
    expect(mockTx.patunganParticipant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'pp1', status: PatunganParticipantStatus.PENDING }),
        data: expect.objectContaining({ orderId: 'o1' }),
      }),
    );
    // M4: grup dibaca ulang di dalam tx.
    expect(mockTx.patunganGroup.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'g1' } }),
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
    mockTx.jastipParticipant.findFirst.mockResolvedValue(null);
    await expect(service.linkOrder('u1', 'pp1', 'o1')).rejects.toThrow('sudah ditautkan');
    expect(mockTx.patunganParticipant.updateMany).not.toHaveBeenCalled();
  });

  it('LOW: linkOrder menolak order yang sudah ditautkan ke peserta JASTIP (lintas modul)', async () => {
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
    mockTx.jastipParticipant.findFirst.mockResolvedValue({ id: 'jp1' }); // order dipakai jastip
    await expect(service.linkOrder('u1', 'pp1', 'o1')).rejects.toThrow('sudah ditautkan');
    expect(mockTx.patunganParticipant.updateMany).not.toHaveBeenCalled();
  });

  it('M4: linkOrder menolak bila peserta sudah PAID (race antar-request)', async () => {
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
    mockTx.jastipParticipant.findFirst.mockResolvedValue(null);
    mockTx.patunganParticipant.updateMany.mockResolvedValue({ count: 0 }); // kalah race
    await expect(service.linkOrder('u1', 'pp1', 'o1')).rejects.toThrow('sudah dalam proses');
  });

  it('M4: linkOrder rollback bila grup berubah status di tengah tx (kalah race vs deadline)', async () => {
    const participant = {
      id: 'pp1', userId: 'u1', groupId: 'g1', amount: 25000000n,
      status: PatunganParticipantStatus.PENDING,
      group: { id: 'g1', hostId: 'h1', status: PatunganStatus.OPEN, targetAmount: 25000000n },
    };
    mockPrisma.patunganParticipant.findFirst.mockResolvedValue(participant);
    mockPrisma.order.findFirst.mockResolvedValue({
      id: 'o1', buyerId: 'u1', sellerId: 'h1', orderValue: 25000000n, status: OrderStatus.PROCESSING,
    });
    mockTx.patunganParticipant.findFirst.mockResolvedValue(null);
    mockTx.jastipParticipant.findFirst.mockResolvedValue(null);
    mockTx.patunganParticipant.updateMany.mockResolvedValue({ count: 1 });
    mockTx.patunganGroup.findUnique.mockResolvedValue({ status: PatunganStatus.OPEN, targetAmount: 25000000n });
    mockTx.patunganParticipant.aggregate.mockResolvedValue({ _sum: { amount: 25000000n } });
    mockTx.patunganGroup.updateMany.mockResolvedValue({ count: 0 }); // grup sudah FAILED oleh deadline
    await expect(service.linkOrder('u1', 'pp1', 'o1')).rejects.toThrow('berubah status');
  });

  it('M4: processDeadlines — target tercapai → TARGET_REACHED kondisional, tanpa refund', async () => {
    mockPrisma.patunganGroup.findMany
      .mockResolvedValueOnce([{ id: 'g1', hostId: 'h1' }]) // expiredOpen
      .mockResolvedValueOnce([]); // contestDone
    mockTx.patunganGroup.findUnique.mockResolvedValue({ status: PatunganStatus.OPEN, targetAmount: 100000000n });
    mockTx.patunganParticipant.aggregate.mockResolvedValue({ _sum: { amount: 100000000n } });
    mockTx.patunganGroup.updateMany.mockResolvedValue({ count: 1 });
    const res = await service.processDeadlines();
    expect(res.failed).toBe(0);
    expect(mockTx.patunganGroup.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'g1', status: PatunganStatus.OPEN }),
        data: { status: PatunganStatus.TARGET_REACHED },
      }),
    );
    expect(mockOrderState.cancelOrder).not.toHaveBeenCalled();
  });

  it('M4: processDeadlines — target tak tercapai → FAILED kondisional + refund peserta (P2-4)', async () => {
    mockPrisma.patunganGroup.findMany
      .mockResolvedValueOnce([{ id: 'g1' }])
      .mockResolvedValueOnce([]);
    mockTx.patunganGroup.findUnique.mockResolvedValue({ status: PatunganStatus.OPEN, targetAmount: 100000000n });
    mockTx.patunganParticipant.aggregate.mockResolvedValue({ _sum: { amount: 25000000n } });
    mockTx.patunganGroup.updateMany.mockResolvedValue({ count: 1 }); // klaim FAILED berhasil
    mockPrisma.patunganParticipant.findMany.mockResolvedValue([
      { id: 'pp1', orderId: 'o1', status: PatunganParticipantStatus.PAID },
      { id: 'pp2', orderId: null, status: PatunganParticipantStatus.PENDING },
    ]);
    mockPrisma.patunganParticipant.updateMany.mockResolvedValue({ count: 1 });
    const res = await service.processDeadlines();
    expect(res.failed).toBe(1);
    expect(mockTx.patunganGroup.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'g1', status: PatunganStatus.OPEN }),
        data: { status: PatunganStatus.FAILED },
      }),
    );
    // P2-4: tanpa dead path cancelOrder — peserta PAID langsung REFUND_REQUIRED.
    expect(mockOrderState.cancelOrder).not.toHaveBeenCalled();
    // Peserta PAID → REFUND_REQUIRED, PENDING → REFUNDED, semua via predicate status.
    expect(mockPrisma.patunganParticipant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: PatunganParticipantStatus.PAID }),
        data: expect.objectContaining({ status: PatunganParticipantStatus.REFUND_REQUIRED }),
      }),
    );
  });

  it('M4: processDeadlines — kalah race (grup sudah berpindah) → lewati tanpa refund', async () => {
    mockPrisma.patunganGroup.findMany
      .mockResolvedValueOnce([{ id: 'g1', hostId: 'h1' }])
      .mockResolvedValueOnce([]);
    mockTx.patunganGroup.findUnique.mockResolvedValue({ status: PatunganStatus.TARGET_REACHED, targetAmount: 100000000n });
    const res = await service.processDeadlines();
    expect(res).toEqual({ failed: 0, released: 0 });
    expect(mockOrderState.cancelOrder).not.toHaveBeenCalled();
    expect(mockPrisma.patunganParticipant.findMany).not.toHaveBeenCalled();
  });

  it('M4: processDeadlines — CONTEST → RELEASED kondisional; predicate gagal → lewati', async () => {
    mockPrisma.patunganGroup.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'g1' }, { id: 'g2' }]);
    // LOW #3: tidak ada order tertaut → tidak ada sengketa → jalur rilis.
    mockTx.patunganParticipant.findMany.mockResolvedValue([]);
    mockTx.patunganGroup.updateMany
      .mockResolvedValueOnce({ count: 1 }) // g1: masih CONTEST
      .mockResolvedValueOnce({ count: 0 }); // g2: sudah berpindah (dispute)
    mockTx.patunganParticipant.updateMany.mockResolvedValue({ count: 1 });
    const res = await service.processDeadlines();
    expect(res.released).toBe(1);
    expect(mockTx.patunganGroup.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'g1', status: PatunganStatus.CONTEST }),
        data: expect.objectContaining({ status: PatunganStatus.RELEASED }),
      }),
    );
  });

  it('LOW #3: CONTEST → RELEASED DITAHAN bila order peserta berstatus DISPUTED', async () => {
    mockPrisma.patunganGroup.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'g1' }]);
    mockTx.patunganParticipant.findMany.mockResolvedValue([{ orderId: 'o1' }]);
    mockTx.order.count.mockResolvedValue(1); // o1 DISPUTED
    mockTx.dispute.count.mockResolvedValue(0);
    mockTx.patunganGroup.updateMany.mockResolvedValue({ count: 1 });
    const res = await service.processDeadlines();
    expect(res.released).toBe(0);
    // Masa sanggah diperpanjang, BUKAN release.
    expect(mockTx.patunganGroup.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'g1', status: PatunganStatus.CONTEST }),
        data: expect.objectContaining({ contestEndsAt: expect.any(Date) }),
      }),
    );
    expect(mockTx.patunganGroup.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: PatunganStatus.RELEASED }) }),
    );
  });

  it('LOW #3: CONTEST → RELEASED DITAHAN bila ada baris dispute non-final', async () => {
    mockPrisma.patunganGroup.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'g1' }]);
    mockTx.patunganParticipant.findMany.mockResolvedValue([{ orderId: 'o1' }]);
    mockTx.order.count.mockResolvedValue(0);
    mockTx.dispute.count.mockResolvedValue(2); // 2 dispute OPEN/ESCALATED
    mockTx.patunganGroup.updateMany.mockResolvedValue({ count: 1 });
    const res = await service.processDeadlines();
    expect(res.released).toBe(0);
    expect(mockTx.dispute.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ orderId: { in: ['o1'] } }) }),
    );
  });

  it('LOW #3: CONTEST → RELEASED bila order tertaut tanpa sengketa', async () => {
    mockPrisma.patunganGroup.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'g1' }]);
    mockTx.patunganParticipant.findMany.mockResolvedValue([{ orderId: 'o1' }, { orderId: 'o2' }]);
    mockTx.order.count.mockResolvedValue(0);
    mockTx.dispute.count.mockResolvedValue(0);
    mockTx.patunganGroup.updateMany.mockResolvedValue({ count: 1 });
    mockTx.patunganParticipant.updateMany.mockResolvedValue({ count: 2 });
    const res = await service.processDeadlines();
    expect(res.released).toBe(1);
    expect(mockTx.patunganGroup.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: PatunganStatus.RELEASED }),
      }),
    );
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

  // ── LOW #1: endpoint leave ────────────────────────────────────────────

  it('LOW #1: leaveGroup — peserta PENDING bisa keluar', async () => {
    mockPrisma.patunganParticipant.findFirst.mockResolvedValue({
      id: 'pp1', userId: 'u1', groupId: 'g1',
      status: PatunganParticipantStatus.PENDING,
      group: { status: PatunganStatus.OPEN },
    });
    mockPrisma.patunganParticipant.deleteMany.mockResolvedValue({ count: 1 });
    const res = await service.leaveGroup('u1', 'pp1');
    expect(res).toEqual({ left: true, participantId: 'pp1', groupId: 'g1' });
    // Predicate delete: hanya baris yang masih PENDING.
    expect(mockPrisma.patunganParticipant.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'pp1', status: PatunganParticipantStatus.PENDING }) }),
    );
  });

  it('LOW #1: leaveGroup — peserta PAID ditolak (wajib alur order)', async () => {
    mockPrisma.patunganParticipant.findFirst.mockResolvedValue({
      id: 'pp1', userId: 'u1', groupId: 'g1',
      status: PatunganParticipantStatus.PAID,
      group: { status: PatunganStatus.OPEN },
    });
    await expect(service.leaveGroup('u1', 'pp1')).rejects.toThrow('PENDING');
    expect(mockPrisma.patunganParticipant.deleteMany).not.toHaveBeenCalled();
  });

  it('LOW #1: leaveGroup — peserta milik user lain → 404', async () => {
    mockPrisma.patunganParticipant.findFirst.mockResolvedValue(null);
    await expect(service.leaveGroup('u2', 'pp1')).rejects.toThrow('tidak ditemukan');
    expect(mockPrisma.patunganParticipant.deleteMany).not.toHaveBeenCalled();
  });

  it('LOW #1: leaveGroup — grup RELEASED ditolak', async () => {
    mockPrisma.patunganParticipant.findFirst.mockResolvedValue({
      id: 'pp1', userId: 'u1', groupId: 'g1',
      status: PatunganParticipantStatus.PENDING,
      group: { status: PatunganStatus.RELEASED },
    });
    await expect(service.leaveGroup('u1', 'pp1')).rejects.toThrow('dicairkan');
    expect(mockPrisma.patunganParticipant.deleteMany).not.toHaveBeenCalled();
  });

  it('LOW #1: leaveGroup — kalah race dengan linkOrder (delete 0) → Conflict fail-closed', async () => {
    mockPrisma.patunganParticipant.findFirst.mockResolvedValue({
      id: 'pp1', userId: 'u1', groupId: 'g1',
      status: PatunganParticipantStatus.PENDING,
      group: { status: PatunganStatus.OPEN },
    });
    mockPrisma.patunganParticipant.deleteMany.mockResolvedValue({ count: 0 });
    await expect(service.leaveGroup('u1', 'pp1')).rejects.toThrow('berubah');
  });
});
