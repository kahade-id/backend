import { Injectable, NotFoundException, ForbiddenException, BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { randomInt } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { OrderStatus, DeadlineExtensionStatus, UserRole, NotificationType, Prisma } from '@prisma/client';
import { addDays } from '../../common/utils/date.util';
import { NotificationQueueService } from '../queue/notification-queue.service';
import * as ErrorCodes from '../../common/constants/error-codes';
import { EXTENSION_REQUEST_LOCK } from '../../common/constants/redis-keys';

const EXTENSION_RATE_LIMIT_SECONDS = 3600;

@Injectable()
export class OrderExtensionsService {
  private readonly logger = new Logger(OrderExtensionsService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private notificationQueue: NotificationQueueService,
  ) {}

  private isRetryableDbError(err: unknown): boolean {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') return true;
    if (err instanceof Prisma.PrismaClientUnknownRequestError) {
      const msg = err.message.toLowerCase();
      if (msg.includes('40001') || msg.includes('serialization') || msg.includes('40p01') || msg.includes('deadlock')) return true;
    }
    return false;
  }

  /*
   * C-24: both transactions in this file are Serializable and neither had a retry, so a `40001`
   * from contention surfaced as an opaque 500 on a request the caller was entitled to make. The
   * approval path is the contended one by construction — it takes `SELECT … FOR UPDATE` on the
   * order row (`:179`) while the auto-complete cron writes `deliveryDeadlineAt` on exactly those
   * orders (`auto-complete-orders.service.ts:134`).
   *
   * Shaped as a helper rather than the inline loop used in `order-state.service.ts:570`, following
   * `users.service.ts:1005`, which does the same across 4 call sites. The predicate above is still
   * the verbatim module one so the two cannot drift apart.
   *
   * A domain rejection (`BadRequestException`, `ConflictException`) is rethrown on the first
   * attempt: retrying a deterministic 4xx only delays the same 4xx by ~300 ms.
   */
  private async withSerializableRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err: unknown) {
        if (!this.isRetryableDbError(err)) throw err;
        if (attempt === MAX_RETRIES) {
          this.logger.error(`${label} gave up after ${MAX_RETRIES} attempts`, err instanceof Error ? err.stack : String(err));
          throw err;
        }
        this.logger.warn(`${label} retrying attempt=${attempt}/${MAX_RETRIES}`);
        await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt - 1) + randomInt(0, 50)));
      }
    }
    throw new Error(`${label}: unreachable`);
  }

  async requestExtension(orderId: string, requesterId: string, dto: { extensionDays: number; reason: string }): Promise<{ extensionId: string; requestedDays: number; status: string }> {
    const normalizedReason = dto.reason.trim();
    if (!Number.isInteger(dto.extensionDays) || dto.extensionDays < 1 || dto.extensionDays > 14) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Extension days must be an integer between 1 and 14' });
    }
    if (normalizedReason.length < 10 || normalizedReason.length > 1000) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Extension reason must be between 10 and 1000 characters' });
    }
    const order = await this.prisma.order.findUnique({ where: { orderId } });
    if (!order) throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });

    if (order.sellerId !== requesterId) throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Only the seller can request a delivery extension' });

    const rateLimitKey = `extension_rate:${order.id}`;
    const rateLimited = await this.redis.get(rateLimitKey);
    if (rateLimited) {
      throw new BadRequestException({
        code: ErrorCodes.EXTENSION_RATE_LIMITED,
        message: 'Please wait before requesting another extension for this order',
      });
    }

    const lockKey = EXTENSION_REQUEST_LOCK(order.id);
    const lockValue = `${requesterId}:${Date.now()}`;
    const acquired = await this.redis.setNx(lockKey, lockValue, 10);
    if (!acquired) {
      throw new ConflictException({
        code: ErrorCodes.EXTENSION_REQUEST_ALREADY_PENDING,
        message: 'Another extension request is being processed, please retry',
      });
    }

    try {
      const extension = await this.withSerializableRetry(() => this.prisma.$transaction(async (tx) => {
        const freshOrder = await tx.order.findUnique({ where: { id: order.id } });
        if (!freshOrder || freshOrder.status !== OrderStatus.IN_DELIVERY) {
          throw new BadRequestException({
            code: ErrorCodes.INVALID_ORDER_STATUS,
            message: 'Extension can only be requested for orders that are in delivery',
          });
        }

        if (freshOrder.deliveryDeadlineAt && new Date() >= freshOrder.deliveryDeadlineAt) {
          throw new BadRequestException({
            code: ErrorCodes.INVALID_ORDER_STATUS,
            message: 'Cannot request extension after the delivery deadline has passed',
          });
        }

        const existingPending = await tx.orderExtensionRequest.findFirst({
          where: { orderId: order.id, status: DeadlineExtensionStatus.PENDING },
        });
        if (existingPending) {
          throw new ConflictException({
            code: ErrorCodes.EXTENSION_REQUEST_ALREADY_PENDING,
            message: 'There is already a pending extension request for this order',
          });
        }

        const approvedCount = await tx.orderExtensionRequest.count({
          where: { orderId: order.id, status: DeadlineExtensionStatus.APPROVED },
        });
        if (approvedCount >= 3) {
          throw new BadRequestException({
            code: ErrorCodes.EXTENSION_LIMIT_REACHED,
            message: 'Maximum 3 extensions allowed per order',
          });
        }

        return tx.orderExtensionRequest.create({
          data: {
            orderId: order.id,
            requestedBy: requesterId,
            requestedByRole: UserRole.SELLER,
            extensionDays: dto.extensionDays,
            reason: normalizedReason,
            status: DeadlineExtensionStatus.PENDING,
          },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }), 'REQUEST_EXTENSION_TX');
      void (async () => {
        try {
          const notifOrder = await this.prisma.order.findUnique({ where: { orderId }, select: { buyerId: true, title: true } });
          if (notifOrder) {
            await this.notificationQueue.enqueue({
              userId: notifOrder.buyerId,
              type: NotificationType.ORDER_EXTENSION_REQUESTED,
              title: 'Extension Request',
              body: `Seller requested a ${dto.extensionDays}-day extension for order "${notifOrder.title}". Please approve or reject.`,
              pushData: { type: 'ORDER_EXTENSION_REQUESTED', orderId },
            });
          }
        } catch (error: unknown) {
          this.logger.warn(`REQUEST_EXTENSION notification failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      })();

      await this.redis.set(rateLimitKey, '1', EXTENSION_RATE_LIMIT_SECONDS).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));

      return { extensionId: extension.id, requestedDays: dto.extensionDays, status: 'PENDING' };
    } finally {
      try {
        await this.redis.releaseLock(lockKey, lockValue);
      } catch (error: unknown) {
        this.logger.warn(`REQUEST_EXTENSION lock release failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async respondExtension(extensionId: string, responderId: string, dto: { action: 'APPROVE' | 'REJECT'; note?: string }, orderId?: string): Promise<{ extensionId: string; status: DeadlineExtensionStatus }> {
    if (dto.action !== 'APPROVE' && dto.action !== 'REJECT') {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Extension action must be APPROVE or REJECT' });
    }
    const normalizedNote = typeof dto.note === 'string' ? dto.note.trim() : undefined;
    if (normalizedNote && normalizedNote.length > 500) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Extension response note must be at most 500 characters' });
    }
    const extension = await this.prisma.orderExtensionRequest.findUnique({ where: { id: extensionId }, include: { order: true } });
    if (!extension) throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Extension request not found' });

    const order = extension.order;
    if (orderId && order.orderId !== orderId) throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Extension request not found for this order' });

    if (order.buyerId !== responderId) throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Only the buyer can approve or reject an extension request' });

    if (extension.status !== DeadlineExtensionStatus.PENDING) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_ORDER_STATUS,
        message: 'This extension request has already been processed',
      });
    }

    if (dto.action === 'APPROVE' && !order.deliveryDeadlineAt) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_ORDER_STATUS,
        message: 'Cannot approve extension: order has no delivery deadline set',
      });
    }

    const newStatus = dto.action === 'APPROVE' ? DeadlineExtensionStatus.APPROVED : DeadlineExtensionStatus.REJECTED;

    await this.withSerializableRetry(() => this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const updated = await tx.orderExtensionRequest.updateMany({
        where: { id: extensionId, status: DeadlineExtensionStatus.PENDING },
        data: {
          status: newStatus,
          respondedBy: responderId,
          respondedAt: new Date(),
          rejectionNote: dto.action === 'REJECT' ? normalizedNote : undefined,
        },
      });

      if (updated.count === 0) {
        throw new ConflictException({
          code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
          message: 'Extension request status has already changed, please retry',
        });
      }

      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`;
      const freshOrderState = await tx.order.findUnique({ where: { id: order.id }, select: { status: true, buyerId: true } });
      if (!freshOrderState || freshOrderState.buyerId !== responderId || freshOrderState.status !== OrderStatus.IN_DELIVERY) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Extension can only be processed while the order is still in delivery' });
      }

      if (dto.action === 'APPROVE') {
        /*
         * C-09: recompute the new deadline from a *fresh, locked* read of the order.
         *
         * `order` here came from the `include: { order: true }` at the top of this method —
         * an unlocked snapshot taken several round trips before this write. The old code did
         * `addDays(order.deliveryDeadlineAt!, …)` on that snapshot and wrote the result with a
         * blind `update`, which silently discarded any deadline change committed in between.
         *
         * That is a live race, not a theoretical one: the auto-complete cron writes
         * `deliveryDeadlineAt` on exactly these orders when the deadline lapses, granting a
         * 48-hour grace window (`auto-complete-orders.service.ts:134`). A seller can request an
         * extension before the deadline and the buyer approve it after — the request-time guard
         * at `:57` blocks late *requests*, not late *approvals*. The approval then overwrote the
         * grace window with `originalDeadline + extensionDays`, which for an order already past
         * due can land in the past, immediately re-arming auto-completion and releasing escrow
         * on an order whose extension the buyer had just granted.
         *
         * The row lock (rather than relying on Serializable alone) matches `submitDispute:619`
         * and the escrow paths. It narrows the conflict window but does not remove it, so this
         * transaction also runs under `withSerializableRetry` (C-24) — without it a bare 40001
         * from that contention surfaced as an opaque 500.
         */
        await tx.$queryRaw`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`;

        const freshOrder = await tx.order.findUnique({
          where: { id: order.id },
          select: { status: true, deliveryDeadlineAt: true },
        });
        if (!freshOrder || freshOrder.status !== OrderStatus.IN_DELIVERY) {
          throw new BadRequestException({
            code: ErrorCodes.INVALID_ORDER_STATUS,
            message: 'Cannot approve extension unless the order is still in delivery',
          });
        }
        if (!freshOrder.deliveryDeadlineAt) {
          throw new BadRequestException({
            code: ErrorCodes.INVALID_ORDER_STATUS,
            message: 'Cannot approve extension: order has no delivery deadline set',
          });
        }
        if (freshOrder.deliveryDeadlineAt <= new Date()) {
          throw new BadRequestException({
            code: ErrorCodes.INVALID_ORDER_STATUS,
            message: 'Cannot approve extension after the delivery deadline has passed',
          });
        }

        await tx.order.update({
          where: { id: order.id },
          data: { deliveryDeadlineAt: addDays(freshOrder.deliveryDeadlineAt, extension.extensionDays) },
        });
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }), 'RESPOND_EXTENSION_TX');

    void (async () => {
      try {
        const notifOrder2 = await this.prisma.order.findUnique({ where: { id: extension.order.id }, select: { orderId: true, sellerId: true, title: true } });
        if (notifOrder2) {
          const notifType = dto.action === 'APPROVE' ? NotificationType.ORDER_EXTENSION_APPROVED : NotificationType.ORDER_EXTENSION_REJECTED;
          const notifTitle = dto.action === 'APPROVE' ? 'Extension Approved' : 'Extension Rejected';
          const notifBody = dto.action === 'APPROVE'
            ? `${extension.extensionDays}-day extension for order "${notifOrder2.title}" has been approved.`
              : `Extension for order "${notifOrder2.title}" has been rejected.${normalizedNote ? ` Note: ${normalizedNote}` : ''}`;
          await this.notificationQueue.enqueue({
            userId: notifOrder2.sellerId,
            type: notifType,
            title: notifTitle,
            body: notifBody,
            pushData: { type: notifType, orderId: notifOrder2.orderId },
          });
        }
      } catch (error: unknown) {
        this.logger.warn(`RESPOND_EXTENSION notification failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();

    return { extensionId, status: newStatus };
  }

  async getExtensions(orderId: string, userId: string, page: number = 1, limit: number = 20): Promise<{
    data: object[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const safePage = Math.max(1, Math.trunc(Number.isFinite(page) ? page : 1));
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number.isFinite(limit) ? limit : 20)));
    const skip = (safePage - 1) * safeLimit;

    const order = await this.prisma.order.findUnique({ where: { orderId } });
    if (!order) throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
    if (order.buyerId !== userId && order.sellerId !== userId) throw new ForbiddenException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Not authorized' });

    const [extensions, total] = await Promise.all([
      this.prisma.orderExtensionRequest.findMany({
        where: { orderId: order.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: safeLimit,
        include: {
          requester: {
            select: { username: true, fullName: true },
          },
        },
      }),
      this.prisma.orderExtensionRequest.count({ where: { orderId: order.id } }),
    ]);

    return {
      data: extensions.map((ext) => ({
        id: ext.id,
        orderId: ext.orderId,
        requestedBy: ext.requestedBy,
        requestedByRole: ext.requestedByRole,
        extensionDays: ext.extensionDays,
        reason: ext.reason,
        status: ext.status,
        respondedBy: ext.respondedBy,
        respondedAt: ext.respondedAt,
        rejectionNote: ext.rejectionNote,
        createdAt: ext.createdAt,
        updatedAt: ext.updatedAt,
        requestedByUser: ext.requester
          ? { username: ext.requester.username ?? '', fullName: ext.requester.fullName }
          : undefined,
      })),
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    };
  }
}
