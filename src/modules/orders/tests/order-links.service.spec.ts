import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { OrderLinksService } from '../order-links.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { FeeCalculatorService } from '../fee-calculator.service';
import { NotificationQueueService } from '../../queue/notification-queue.service';

/*
 * C-23 regression: `acceptLink`'s transaction runs at Serializable and writes four rows in one
 * shot — the guarded `orderLink.updateMany`, the order, its chat room and its status-history row.
 * A concurrent write touching the same rows aborts it with a 40001, which is contention, not a
 * fault. Without a retry that surfaced as an opaque 500 on a link the acceptor was entitled to
 * accept; worse, because the guarded `updateMany` may or may not have committed, the acceptor's
 * own retry could come back ORDER_LINK_ALREADY_USED for a link that was still ACTIVE.
 *
 * The order serial is drawn ABOVE the retry loop on purpose, so an in-place retry reuses the same
 * orderId and leaves no gap in the day's order sequence. That decision is only observable through
 * the eval-call count, so it gets its own test.
 */

const mockPrisma = {
  orderLink: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  user: { findUnique: jest.fn() },
  subscription: { findFirst: jest.fn() },
  blockList: { findFirst: jest.fn() },
  order: { create: jest.fn() },
  chatRoom: { create: jest.fn() },
  orderStatusHistory: { create: jest.fn() },
  $transaction: jest.fn(),
};

const mockRedisClient = { eval: jest.fn() };
const mockRedis = {
  getClient: jest.fn(() => mockRedisClient),
  getPrefix: jest.fn(() => 'kahade:'),
};

const FEE_RESULT = {
  feeAmount: 20_000n,
  buyerFeeAmount: 20_000n,
  sellerFeeAmount: 0n,
  buyerPayAmount: 1_020_000n,
  sellerReceiveAmount: 1_000_000n,
  voucherDiscount: 0n,
  feeRate: 2,
};
const mockFeeCalculator = {
  getFeeConfig: jest.fn().mockResolvedValue({}),
  calculateFee: jest.fn(() => FEE_RESULT),
};

const mockQueue = { enqueue: jest.fn() };

const LINK = {
  id: 'link-row-1',
  linkId: 'LNK-0001',
  token: 'tok-1',
  creatorId: 'creator',
  creatorRole: 'SELLER',
  status: 'ACTIVE',
  expiresAt: new Date('2099-01-01T00:00:00Z'),
  counterpartUsername: null,
  orderValue: 1_000_000n, // Rp 10.000 — under KYC_THRESHOLD, so no KYC gate on this path
  title: 'Jasa desain logo',
  description: 'Logo untuk toko',
  orderType: 'SERVICE',
  feeResponsibility: 'BUYER',
  deliveryDeadlineDays: 3,
};

const CREATED_ORDER = { id: 'ord-row-1', orderId: 'ORD-20260101-000007-ABCD', status: 'WAITING_CONFIRMATION' };
const TX_RESULT = { order: CREATED_ORDER, creatorId: 'creator' };

const serializationFailure = () =>
  new Prisma.PrismaClientUnknownRequestError(
    'could not serialize access due to read/write dependencies among transactions (SQLSTATE 40001)',
    { clientVersion: 'test' },
  );

describe('OrderLinksService — acceptLink', () => {
  let service: OrderLinksService;

  beforeEach(async () => {
    // mockReset, not clearAllMocks: these tests queue `...ValueOnce` rejections on $transaction,
    // and a test that makes fewer calls than it queued would leak the remainder into the next one.
    mockPrisma.$transaction.mockReset();
    mockRedisClient.eval.mockReset();
    mockQueue.enqueue.mockReset();

    mockPrisma.orderLink.findUnique.mockResolvedValue({ ...LINK });
    mockPrisma.orderLink.update.mockResolvedValue({});
    mockPrisma.orderLink.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.blockList.findFirst.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue({
      kycStatus: 'APPROVED', isKahadePlus: false, isActive: true, isBanned: false, username: 'acceptor',
    });
    mockPrisma.subscription.findFirst.mockResolvedValue(null);
    mockPrisma.order.create.mockResolvedValue(CREATED_ORDER);
    mockPrisma.chatRoom.create.mockResolvedValue({});
    mockPrisma.orderStatusHistory.create.mockResolvedValue({});
    mockRedisClient.eval.mockResolvedValue(7);
    mockQueue.enqueue.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderLinksService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: FeeCalculatorService, useValue: mockFeeCalculator },
        { provide: NotificationQueueService, useValue: mockQueue },
      ],
    }).compile();
    service = module.get<OrderLinksService>(OrderLinksService);
    // Read through an optional cast rather than `service['logger']`: this suite has to compile
    // against the pre-fix file too when the falsification cycle reverts it, and the field only
    // exists post-fix. Indexing it directly would fail the run at tsc, which proves nothing.
    const logger = (service as unknown as { logger?: Logger }).logger;
    if (logger) {
      jest.spyOn(logger, 'error').mockImplementation(() => undefined);
      jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    }
  });

  describe('C-23 — Serializable retry wrapper', () => {
    it('accepts the link on the happy path, running the real transaction body', async () => {
      mockPrisma.$transaction.mockImplementation(
        async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma),
      );

      await expect(service.acceptLink('tok-1', 'acceptor')).resolves.toEqual({
        orderId: CREATED_ORDER.orderId,
        status: 'WAITING_CONFIRMATION',
      });
      expect(mockPrisma.orderLink.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: LINK.id, status: 'ACTIVE' } }),
      );
      expect(mockPrisma.order.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.chatRoom.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.orderStatusHistory.create).toHaveBeenCalledTimes(1);
    });

    it('retries a serialization failure and succeeds on the next attempt', async () => {
      mockPrisma.$transaction
        .mockRejectedValueOnce(serializationFailure())
        .mockResolvedValueOnce(TX_RESULT);

      await expect(service.acceptLink('tok-1', 'acceptor')).resolves.toEqual({
        orderId: CREATED_ORDER.orderId,
        status: 'WAITING_CONFIRMATION',
      });
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it('treats P2034 as retryable', async () => {
      mockPrisma.$transaction
        .mockRejectedValueOnce(
          new Prisma.PrismaClientKnownRequestError('write conflict', { code: 'P2034', clientVersion: 'test' }),
        )
        .mockResolvedValueOnce(TX_RESULT);

      await expect(service.acceptLink('tok-1', 'acceptor')).resolves.toMatchObject({
        orderId: CREATED_ORDER.orderId,
      });
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it('treats a deadlock (40P01) as retryable', async () => {
      mockPrisma.$transaction
        .mockRejectedValueOnce(
          new Prisma.PrismaClientUnknownRequestError('deadlock detected (SQLSTATE 40P01)', { clientVersion: 'test' }),
        )
        .mockResolvedValueOnce(TX_RESULT);

      await expect(service.acceptLink('tok-1', 'acceptor')).resolves.toMatchObject({
        orderId: CREATED_ORDER.orderId,
      });
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it('draws the order serial ONCE across retries, leaving no gap in the sequence', async () => {
      mockPrisma.$transaction
        .mockRejectedValueOnce(serializationFailure())
        .mockRejectedValueOnce(serializationFailure())
        .mockResolvedValueOnce(TX_RESULT);

      await service.acceptLink('tok-1', 'acceptor');

      // The serial INCR sits above the retry loop deliberately. A caller-level retry (or a loop
      // that redrew it) would burn one order_serial per attempt and leave holes in the day's
      // sequence — the same reason submitDispute draws `dispute_serial` outside its loop.
      expect(mockRedisClient.eval).toHaveBeenCalledTimes(1);
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(3);
    });

    it('reuses the SAME orderId on a retry rather than minting a new one', async () => {
      const seen: string[] = [];
      mockPrisma.order.create.mockImplementation((args: { data: { orderId: string } }) => {
        seen.push(args.data.orderId);
        return Promise.resolve(CREATED_ORDER);
      });
      let call = 0;
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        call += 1;
        const out = await fn(mockPrisma);
        if (call === 1) throw serializationFailure();
        return out;
      });

      await service.acceptLink('tok-1', 'acceptor');

      expect(seen).toHaveLength(2);
      expect(seen[0]).toBe(seen[1]);
    });

    it('gives up after 3 attempts and rethrows rather than looping forever', async () => {
      mockPrisma.$transaction.mockRejectedValue(serializationFailure());

      await expect(service.acceptLink('tok-1', 'acceptor')).rejects.toBeInstanceOf(
        Prisma.PrismaClientUnknownRequestError,
      );
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(3);
    });

    it('does NOT retry a domain rejection thrown inside the transaction', async () => {
      mockPrisma.$transaction.mockRejectedValue(
        new ConflictException({ code: 'ORDER_LINK_ALREADY_USED', message: 'already accepted' }),
      );

      await expect(service.acceptLink('tok-1', 'acceptor')).rejects.toMatchObject({
        response: { code: 'ORDER_LINK_ALREADY_USED' },
      });
      // Retrying a deterministic rejection just delays the same 409 by ~300 ms.
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('does not enqueue the creator notification when every attempt fails', async () => {
      mockPrisma.$transaction.mockRejectedValue(serializationFailure());

      await expect(service.acceptLink('tok-1', 'acceptor')).rejects.toBeTruthy();
      expect(mockQueue.enqueue).not.toHaveBeenCalled();
    });

    it('notifies the link creator once the retry succeeds, not the acceptor', async () => {
      mockPrisma.$transaction
        .mockRejectedValueOnce(serializationFailure())
        .mockResolvedValueOnce(TX_RESULT);

      await service.acceptLink('tok-1', 'acceptor');

      expect(mockQueue.enqueue).toHaveBeenCalledTimes(1);
      expect(mockQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'creator', actionUrl: `/o/${CREATED_ORDER.orderId}` }),
      );
    });
    it('does not apply Kahade Plus fee when the savings limit is exhausted', async () => {
      mockPrisma.user.findUnique
        .mockResolvedValueOnce({ kycStatus: 'APPROVED', isKahadePlus: true, isActive: true, isBanned: false })
        .mockResolvedValueOnce({ kycStatus: 'APPROVED', isActive: true, isBanned: false })
        .mockResolvedValueOnce({ isActive: true, isBanned: false });
      mockPrisma.subscription.findFirst.mockResolvedValue({ feeSavingsUsed: 50n, feeSavingsLimit: 50n });
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma));

      await service.acceptLink('tok-1', 'acceptor');
      expect(mockFeeCalculator.calculateFee).toHaveBeenCalledWith(expect.objectContaining({ isKahadePlus: false }), expect.anything());
    });

    it('applies Kahade Plus fee only with remaining savings', async () => {
      mockPrisma.user.findUnique
        .mockResolvedValueOnce({ kycStatus: 'APPROVED', isKahadePlus: true, isActive: true, isBanned: false })
        .mockResolvedValueOnce({ kycStatus: 'APPROVED', isActive: true, isBanned: false })
        .mockResolvedValueOnce({ isActive: true, isBanned: false });
      mockPrisma.subscription.findFirst.mockResolvedValue({ feeSavingsUsed: 10n, feeSavingsLimit: 50n });
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma));

      await service.acceptLink('tok-1', 'acceptor');
      expect(mockFeeCalculator.calculateFee).toHaveBeenCalledWith(expect.objectContaining({ isKahadePlus: true }), expect.anything());
    });
  });

  describe('createLink and cancelLink hardening', () => {
    it('rejects a suspended creator before consuming a link serial', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: false, isBanned: false });
      await expect(service.createLink('creator', { role: 'SELLER', title: 'Tautan layanan', description: 'Deskripsi layanan yang cukup panjang', orderType: 'SERVICE' as any, orderValue: 100000, deliveryDeadlineDays: 3, feeResponsibility: 'BUYER' as any })).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockRedisClient.eval).not.toHaveBeenCalled();
    });

    it('sanitizes link text and trims the restricted counterpart username', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
      mockPrisma.orderLink.create.mockResolvedValue({ linkId: 'LNK-1', token: 'tok-new', expiresAt: LINK.expiresAt });
      await service.createLink('creator', { role: 'SELLER', title: '<b>Logo</b>', description: '<i>Deskripsi layanan yang cukup panjang</i>', orderType: 'SERVICE' as any, orderValue: 100000, deliveryDeadlineDays: 3, feeResponsibility: 'BUYER' as any, counterpartUsername: '  buyer01  ' });
      expect(mockPrisma.orderLink.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ title: 'bLogo/b', description: 'iDeskripsi layanan yang cukup panjang/i', counterpartUsername: 'buyer01' }) }));
    });

    it('does not mutate an already accepted link even when its expiry is in the past', async () => {
      mockPrisma.orderLink.findUnique.mockResolvedValue({ ...LINK, status: 'ACCEPTED', expiresAt: new Date('2020-01-01T00:00:00Z'), creator: { userId: 'creator', username: 'creator', fullName: 'Creator', avatarUrl: null, membershipRank: 'BASIC', averageRating: null, totalRatingCount: 0, kycStatus: 'APPROVED' } });
      const updateCountBefore = mockPrisma.orderLink.updateMany.mock.calls.length;
      await expect(service.getLinkByToken('tok-1')).rejects.toMatchObject({ response: { code: 'ORDER_LINK_ALREADY_USED' } });
      expect(mockPrisma.orderLink.update).not.toHaveBeenCalled();
      expect(mockPrisma.orderLink.updateMany.mock.calls.length).toBe(updateCountBefore);
    });

    it('marks an expired active link as EXPIRED instead of cancelling it', async () => {
      mockPrisma.orderLink.findUnique.mockResolvedValue({ ...LINK, expiresAt: new Date('2020-01-01T00:00:00Z') });
      await expect(service.cancelLink('tok-1', 'creator')).rejects.toMatchObject({ response: { code: 'ORDER_LINK_EXPIRED' } });
      expect(mockPrisma.orderLink.updateMany).toHaveBeenCalledWith({ where: { id: LINK.id, status: 'ACTIVE' }, data: { status: 'EXPIRED' } });
    });
    it('rejects cancellation when the creator is suspended at mutation time', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: false, isBanned: false });
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma));

      await expect(service.cancelLink('tok-1', 'creator')).rejects.toMatchObject({ response: { code: 'COUNTERPART_SUSPENDED' } });
    });
    it('cancels an active link atomically', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma));

      await expect(service.cancelLink('tok-1', 'creator')).resolves.toEqual({ message: 'Order link cancelled' });
      expect(mockPrisma.orderLink.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'CANCELLED' } }));
    });
  });

  describe('pre-transaction guards still reject before any serial is drawn', () => {
    it('rejects accepting your own link', async () => {
      await expect(service.acceptLink('tok-1', 'creator')).rejects.toMatchObject({
        response: { code: 'ORDER_LINK_OWN' },
      });
      expect(mockRedisClient.eval).not.toHaveBeenCalled();
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects an already-accepted link', async () => {
      mockPrisma.orderLink.findUnique.mockResolvedValue({ ...LINK, status: 'ACCEPTED' });

      await expect(service.acceptLink('tok-1', 'acceptor')).rejects.toMatchObject({
        response: { code: 'ORDER_LINK_ALREADY_USED' },
      });
      expect(mockRedisClient.eval).not.toHaveBeenCalled();
    });

    it('rejects an expired link and marks it EXPIRED', async () => {
      mockPrisma.orderLink.findUnique.mockResolvedValue({
        ...LINK, expiresAt: new Date('2020-01-01T00:00:00Z'),
      });

      await expect(service.acceptLink('tok-1', 'acceptor')).rejects.toMatchObject({
        response: { code: 'ORDER_LINK_EXPIRED' },
      });
      expect(mockPrisma.orderLink.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: LINK.id }, data: { status: 'EXPIRED' } }),
      );
      expect(mockRedisClient.eval).not.toHaveBeenCalled();
    });

    it('rejects when either party has blocked the other', async () => {
      mockPrisma.blockList.findFirst.mockResolvedValue({ id: 'block-1' });

      await expect(service.acceptLink('tok-1', 'acceptor')).rejects.toMatchObject({
        response: { code: 'USER_BLOCKED' },
      });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
