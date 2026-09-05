import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException, Logger } from '@nestjs/common';
import { DeadlineExtensionStatus, OrderStatus, Prisma } from '@prisma/client';
import { OrderExtensionsService } from '../order-extensions.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { NotificationQueueService } from '../../queue/notification-queue.service';

/*
 * C-09 regression: `respondExtension` computed the new deadline from the unlocked
 * `include: { order: true }` snapshot read at the top of the method, then blind-wrote it.
 * The auto-complete cron writes `deliveryDeadlineAt` on exactly these orders to grant a
 * 48-hour grace window (`auto-complete-orders.service.ts:134`), so an approval landing
 * after that grant overwrote it with `originalDeadline + extensionDays` — a value that,
 * for an order already past due, can land in the past and immediately re-arm auto-completion.
 */

const ORIGINAL_DEADLINE = new Date('2099-01-10T00:00:00Z');
const GRACE_DEADLINE = new Date('2099-01-12T00:00:00Z'); // cron granted +48h after the deadline lapsed

const mockPrisma = {
  order: { findUnique: jest.fn(), update: jest.fn() },
  orderExtensionRequest: { findUnique: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn(), count: jest.fn(), create: jest.fn(), findMany: jest.fn() },
  $transaction: jest.fn(),
  $queryRaw: jest.fn(),
};
const mockRedis = { get: jest.fn(), set: jest.fn(), setNx: jest.fn(), releaseLock: jest.fn() };
const mockQueue = { enqueue: jest.fn() };

const ORDER = {
  id: 'ord-1',
  orderId: 'ORD-1',
  buyerId: 'buyer',
  sellerId: 'seller',
  title: 'Jasa desain',
  status: OrderStatus.IN_DELIVERY,
  deliveryDeadlineAt: ORIGINAL_DEADLINE,
};

describe('OrderExtensionsService', () => {
  let service: OrderExtensionsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderExtensionsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: NotificationQueueService, useValue: mockQueue },
      ],
    }).compile();
    service = module.get<OrderExtensionsService>(OrderExtensionsService);
  });

  describe('respondExtension — stale deadline race (C-09)', () => {
    function arrange(freshDeadline: Date | null) {
      mockPrisma.orderExtensionRequest.findUnique.mockResolvedValue({
        id: 'ext-1',
        status: DeadlineExtensionStatus.PENDING,
        extensionDays: 3,
        order: { ...ORDER },
      });
      mockPrisma.orderExtensionRequest.updateMany.mockResolvedValue({ count: 1 });
      // What the row actually holds now — the cron already moved it.
      mockPrisma.order.findUnique.mockImplementation((args: { select?: Record<string, boolean> }) => {
        if (args?.select?.deliveryDeadlineAt || args?.select?.buyerId) return Promise.resolve({ status: OrderStatus.IN_DELIVERY, buyerId: 'buyer', deliveryDeadlineAt: freshDeadline });
        return Promise.resolve({ orderId: 'ORD-1', sellerId: 'seller', title: 'Jasa desain' });
      });
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma));
    }

    it('extends from the CURRENT deadline, not the stale pre-transaction snapshot', async () => {
      arrange(GRACE_DEADLINE);

      await service.respondExtension('ext-1', 'buyer', { action: 'APPROVE' });

      const written = mockPrisma.order.update.mock.calls[0][0].data.deliveryDeadlineAt as Date;
      // GRACE_DEADLINE + 3 days — the grace window the cron granted is preserved.
      expect(written.toISOString()).toBe('2099-01-15T00:00:00.000Z');
      // Pre-fix this was ORIGINAL_DEADLINE + 3 days, silently discarding the grace grant.
      expect(written.toISOString()).not.toBe('2099-01-13T00:00:00.000Z');
    });

    it('locks the order row before reading the deadline it extends from', async () => {
      arrange(GRACE_DEADLINE);

      await service.respondExtension('ext-1', 'buyer', { action: 'APPROVE' });

      expect(mockPrisma.$queryRaw).toHaveBeenCalled();
      const lockOrder = mockPrisma.$queryRaw.mock.invocationCallOrder[0];
      const writeOrder = mockPrisma.order.update.mock.invocationCallOrder[0];
      expect(lockOrder).toBeLessThan(writeOrder);
    });

    it('throws instead of writing when the deadline was cleared before the approval', async () => {
      arrange(null);

      await expect(service.respondExtension('ext-1', 'buyer', { action: 'APPROVE' })).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.order.update).not.toHaveBeenCalled();
    });

    it('rejects approval when the current deadline has already elapsed', async () => {
      arrange(new Date('2020-01-01T00:00:00Z'));
      await expect(service.respondExtension('ext-1', 'buyer', { action: 'APPROVE' })).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.order.update).not.toHaveBeenCalled();
    });

    it('rejects invalid action and oversized response note before lookup', async () => {
      await expect(service.respondExtension('ext-1', 'buyer', { action: 'APPROVE' as never, note: 'x'.repeat(501) })).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.orderExtensionRequest.findUnique).not.toHaveBeenCalled();
    });

    it('does not touch the deadline on REJECT', async () => {
      arrange(GRACE_DEADLINE);

      const res = await service.respondExtension('ext-1', 'buyer', { action: 'REJECT', note: 'tidak bisa' });

      expect(res.status).toBe(DeadlineExtensionStatus.REJECTED);
      expect(mockPrisma.order.update).not.toHaveBeenCalled();
    });

    it('rejects a concurrent double-response via the guarded updateMany', async () => {
      arrange(GRACE_DEADLINE);
      mockPrisma.orderExtensionRequest.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.respondExtension('ext-1', 'buyer', { action: 'APPROVE' })).rejects.toBeInstanceOf(ConflictException);
      expect(mockPrisma.order.update).not.toHaveBeenCalled();
    });

    it('still rejects a non-buyer responder', async () => {
      arrange(GRACE_DEADLINE);

      await expect(service.respondExtension('ext-1', 'seller', { action: 'APPROVE' })).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
  });

  /*
   * C-24: both transactions here are Serializable and neither had a retry wrapper, so a 40001 from
   * contention surfaced as an opaque 500. `respondExtension` is the contended one by construction —
   * it takes `SELECT … FOR UPDATE` on the order row while the auto-complete cron writes
   * `deliveryDeadlineAt` on exactly those orders (`auto-complete-orders.service.ts:134`).
   */
  describe('C-24 — Serializable retry wrapper', () => {
    const serializationFailure = () =>
      new Prisma.PrismaClientUnknownRequestError(
        'could not serialize access due to read/write dependencies among transactions (SQLSTATE 40001)',
        { clientVersion: 'test' },
      );

    beforeEach(() => {
      // mockReset, not clearAllMocks: these tests queue `...ValueOnce` rejections, so an
      // unconsumed queue would leak into the next test.
      mockPrisma.$transaction.mockReset();
      const logger = (service as unknown as { logger?: Logger }).logger;
      if (logger) {
        jest.spyOn(logger, 'error').mockImplementation(() => undefined);
        jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
      }
    });

    describe('respondExtension', () => {
      beforeEach(() => {
        mockPrisma.orderExtensionRequest.findUnique.mockResolvedValue({
          id: 'ext-1',
          status: DeadlineExtensionStatus.PENDING,
          extensionDays: 3,
          order: { ...ORDER },
        });
        mockPrisma.order.findUnique.mockResolvedValue({ orderId: 'ORD-1', sellerId: 'seller', title: 'Jasa desain', status: OrderStatus.IN_DELIVERY, buyerId: 'buyer', deliveryDeadlineAt: GRACE_DEADLINE });
      });

      it('retries a serialization failure and succeeds on the next attempt', async () => {
        mockPrisma.$transaction.mockRejectedValueOnce(serializationFailure()).mockResolvedValueOnce(undefined);

        await expect(service.respondExtension('ext-1', 'buyer', { action: 'APPROVE' })).resolves.toEqual({
          extensionId: 'ext-1',
          status: DeadlineExtensionStatus.APPROVED,
        });
        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
      });

      it('treats P2034 as retryable', async () => {
        mockPrisma.$transaction
          .mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('write conflict', { code: 'P2034', clientVersion: 'test' }))
          .mockResolvedValueOnce(undefined);

        await expect(service.respondExtension('ext-1', 'buyer', { action: 'APPROVE' })).resolves.toBeTruthy();
        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
      });

      it('gives up after 3 attempts and rethrows', async () => {
        mockPrisma.$transaction.mockRejectedValue(serializationFailure());

        await expect(service.respondExtension('ext-1', 'buyer', { action: 'APPROVE' })).rejects.toBeInstanceOf(
          Prisma.PrismaClientUnknownRequestError,
        );
        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(3);
      });

      it('does NOT retry the guarded double-response conflict', async () => {
        mockPrisma.$transaction.mockRejectedValue(
          new ConflictException({ code: 'OPTIMISTIC_LOCK_CONFLICT', message: 'already changed' }),
        );

        await expect(service.respondExtension('ext-1', 'buyer', { action: 'APPROVE' })).rejects.toBeInstanceOf(ConflictException);
        // Retrying a deterministic 409 just delays the same 409 by ~300 ms.
        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      });

      it('does not notify the seller when every attempt fails', async () => {
        mockPrisma.$transaction.mockRejectedValue(serializationFailure());

        await expect(service.respondExtension('ext-1', 'buyer', { action: 'APPROVE' })).rejects.toBeTruthy();
        expect(mockQueue.enqueue).not.toHaveBeenCalled();
      });
    });

    describe('requestExtension', () => {
      beforeEach(() => {
        mockPrisma.order.findUnique.mockResolvedValue({ ...ORDER, buyerId: 'buyer', title: 'Jasa desain' });
        mockRedis.get.mockResolvedValue(null);
        mockRedis.setNx.mockResolvedValue(true);
        mockRedis.set.mockResolvedValue(undefined);
        mockRedis.releaseLock.mockResolvedValue(undefined);
      });

      it('rejects a request at the exact delivery deadline boundary', async () => {
        const deadline = new Date('2099-01-10T00:00:00.000Z');
        jest.useFakeTimers().setSystemTime(deadline);
        try {
          mockPrisma.order.findUnique.mockResolvedValue({ ...ORDER, deliveryDeadlineAt: deadline });
          mockRedis.get.mockResolvedValue(null);
          mockRedis.setNx.mockResolvedValue(true);
          mockRedis.releaseLock.mockResolvedValue(undefined);
          mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma));
          await expect(service.requestExtension('ORD-1', 'seller', { extensionDays: 1, reason: 'deadline boundary reason' })).rejects.toBeInstanceOf(BadRequestException);
          expect(mockPrisma.orderExtensionRequest.create).not.toHaveBeenCalled();
        } finally {
          jest.useRealTimers();
        }
      });

      it('retries a serialization failure and succeeds on the next attempt', async () => {
        mockPrisma.$transaction.mockRejectedValueOnce(serializationFailure()).mockResolvedValueOnce({ id: 'ext-9' });

        await expect(
          service.requestExtension('ORD-1', 'seller', { extensionDays: 2, reason: 'butuh waktu' }),
        ).resolves.toMatchObject({ extensionId: 'ext-9', status: 'PENDING' });
        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
      });

      it('releases the Redis lock even when every attempt fails', async () => {
        mockPrisma.$transaction.mockRejectedValue(serializationFailure());

        await expect(
          service.requestExtension('ORD-1', 'seller', { extensionDays: 2, reason: 'butuh waktu' }),
        ).rejects.toBeTruthy();
        // The `finally` must still run after the retry loop gives up, or the order is locked out
        // of extension requests for the full 10 s TTL.
        expect(mockRedis.releaseLock).toHaveBeenCalled();
        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(3);
      });

      it('does NOT retry the already-pending domain rejection', async () => {
        mockPrisma.$transaction.mockRejectedValue(
          new ConflictException({ code: 'EXTENSION_REQUEST_ALREADY_PENDING', message: 'pending' }),
        );

        await expect(
          service.requestExtension('ORD-1', 'seller', { extensionDays: 2, reason: 'butuh waktu' }),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      });
    });
  });
});
