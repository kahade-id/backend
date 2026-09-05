import { Injectable, BadRequestException, NotFoundException, ForbiddenException, forwardRef, Inject, Logger } from '@nestjs/common';
import { randomInt } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { Prisma, UserAuditAction, NotificationType, OrderStatus, OrderType, DisputeStatus, DisputeInitiator, ActorType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UploadService } from '../upload/upload.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import { OrderStateService } from './order-state.service';
import { NotificationQueueService } from '../queue/notification-queue.service';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { generateDisputeId } from '../../common/utils/id-generator.util';
import * as ErrorCodes from '../../common/constants/error-codes';
import { DELIVERY_REVIEW_WINDOW_DAYS, DISPUTE_SLA_HOURS } from '../../common/constants/app.constants';

const DELIVERY_PROOF_KEY_PREFIX = 'uploads/delivery-proof/';

@Injectable()
export class DeliveryProofService {
  private readonly logger = new Logger(DeliveryProofService.name);

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private uploadService: UploadService,
    private auditLog: AuditLogService,
    @Inject(forwardRef(() => OrderStateService))
    private orderStateService: OrderStateService,
    private notificationQueue: NotificationQueueService,
    private serialService: WalletTxSerialService,
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
   * C-24: all three transactions in this file are Serializable and none had a retry, so a `40001`
   * from contention surfaced as an opaque 500. `confirmDelivery` and `rejectDelivery` are the
   * contended ones: they race the auto-complete cron, which touches the same order rows once the
   * review window lapses.
   *
   * Shaped as a helper rather than the inline loop used in `order-state.service.ts:570`, following
   * `users.service.ts:1005`, which does the same across 4 call sites. The predicate above is still
   * the verbatim module one so the two cannot drift apart.
   *
   * A domain rejection (`BadRequestException`, `NotFoundException`) is rethrown on the first
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

  private runPostCommitBestEffort(task: () => Promise<void> | void, label: string): void {
    void Promise.resolve().then(task).catch((error: unknown) => {
      this.logger.warn(`${label} post-commit side effect failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private validateFileKeys(keys: string[], userId: string): void {
    if (!Array.isArray(keys) || keys.length > 10) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'A maximum of 10 delivery proof files is allowed' });
    }
    const seen = new Set<string>();
    for (const key of keys) {
      if (typeof key !== 'string' || seen.has(key) || !key.startsWith(DELIVERY_PROOF_KEY_PREFIX)) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'File key must be a unique delivery proof upload key' });
      }
      seen.add(key);
      const segments = key.split('/');
      const objectName = segments[3] ?? '';
      if (segments.length !== 4 || segments[2] !== userId || !objectName || objectName === '.' || objectName === '..' || /[\\\u0000-\u001F\u007F]/.test(objectName)) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid file key or file does not belong to user' });
      }
    }
  }

  async submitProof(orderId: string, userId: string, dto: { description: string; fileUrls?: string[]; linkUrls?: string[] }): Promise<object> {
    const description = typeof dto.description === 'string' ? dto.description.trim() : '';
    if (description.length < 10 || description.length > 2000) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Delivery proof description must be between 10 and 2000 characters' });
    }
    const fileUrls = Array.isArray(dto.fileUrls) ? dto.fileUrls : [];
    this.validateFileKeys(fileUrls, userId);
    const linkUrls = Array.isArray(dto.linkUrls) ? dto.linkUrls : [];
    if (linkUrls.length > 5 || linkUrls.some((url) => typeof url !== 'string' || url.length > 1000 || !/^https?:\/\//i.test(url))) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Delivery proof links must be HTTP(S) URLs and no more than 5 links' });
    }
    const reviewWindowEnd = new Date();
    reviewWindowEnd.setDate(reviewWindowEnd.getDate() + DELIVERY_REVIEW_WINDOW_DAYS);

    const result = await this.withSerializableRetry(() => this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({ where: { orderId } });
      if (!order) throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
      // Serialize proof submissions for the same order. Serializable isolation alone does not
      // prevent two concurrent reads from both seeing no SUBMITTED proof before inserting rows.
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`;
      const lockedOrder = await tx.order.findUnique({ where: { id: order.id } });
      if (!lockedOrder) throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
      if (lockedOrder.sellerId !== userId) throw new ForbiddenException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Only seller can submit delivery proof' });
      if (lockedOrder.status !== OrderStatus.PROCESSING && lockedOrder.status !== OrderStatus.IN_DELIVERY) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order must be in PROCESSING or IN_DELIVERY status' });
      }
      if (lockedOrder.orderType === OrderType.PHYSICAL_GOODS && (!lockedOrder.trackingNumber || !lockedOrder.courierName)) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Tracking number and courier are required before submitting physical delivery proof' });
      }

      const existing = await tx.deliveryProof.findFirst({
        where: { orderId: lockedOrder.id, status: 'SUBMITTED' },
      });
      if (existing) throw new BadRequestException({ code: ErrorCodes.DELIVERY_PROOF_ALREADY_EXISTS, message: 'Delivery proof already submitted and pending review' });

      const p = await tx.deliveryProof.create({
        data: {
          orderId: lockedOrder.id,
          submittedBy: userId,
          description,
          fileUrls,
          linkUrls,
          reviewWindowEnd,
        },
      });

      if (lockedOrder.status === OrderStatus.PROCESSING) {
        const orderUpdated = await tx.order.updateMany({
          where: { id: lockedOrder.id, status: OrderStatus.PROCESSING },
          data: { status: OrderStatus.IN_DELIVERY, shippedAt: new Date() },
        });
        if (orderUpdated.count === 0) {
          throw new BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order status has already changed' });
        }
        await tx.orderStatusHistory.create({
          data: { orderId: lockedOrder.id, fromStatus: OrderStatus.PROCESSING, toStatus: OrderStatus.IN_DELIVERY, changedBy: userId, changedByType: 'SELLER', reason: 'Delivery proof submitted' },
        });
      }

      return { proof: p, buyerId: lockedOrder.buyerId, orderTitle: lockedOrder.title, orderPublicId: lockedOrder.orderId };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }), 'SUBMIT_PROOF_TX');

    this.runPostCommitBestEffort(() => this.notificationQueue.enqueue({
      userId: result.buyerId,
      type: NotificationType.ORDER_DELIVERED,
      title: 'Delivery Proof Submitted',
      body: `Seller has submitted delivery proof for order "${result.orderTitle || result.orderPublicId}". Please review within ${DELIVERY_REVIEW_WINDOW_DAYS} days.`,
      pushData: { type: 'ORDER_DELIVERED', orderId: result.orderPublicId },
    }), 'SUBMIT_PROOF_NOTIFICATION');

    return {
      proofId: result.proof.id,
      status: result.proof.status,
      reviewWindowEnd: result.proof.reviewWindowEnd,
    };
  }

  async getProofs(orderId: string, userId: string): Promise<object[]> {
    const order = await this.prisma.order.findFirst({ where: { orderId } });
    if (!order) throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
    if (order.buyerId !== userId && order.sellerId !== userId) {
      throw new ForbiddenException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Not a participant' });
    }

    const proofs = await this.prisma.deliveryProof.findMany({
      where: { orderId: order.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    const results = await Promise.all(proofs.map(async (p) => {
      let resolvedFileUrls: string[] = [];
      if (p.fileUrls && (p.fileUrls as string[]).length > 0) {
        /*
         * C-08: sign each key independently and drop the ones that fail.
         *
         * `generateDownloadUrl` throws when R2 is unconfigured (`upload.service.ts:183`, :207,
         * :213) and `getSignedUrl` can reject transiently. Inside a bare `Promise.all` the first
         * rejection propagated out of `getProofs`, so one unreadable key turned the buyer's whole
         * proof list into a 500 — hiding the description and link evidence that signed fine, on
         * the screen the buyer uses to decide whether to confirm or reject delivery. This mirrors
         * the `.catch(() => null)` the dispute evidence readers already use
         * (`disputes.service.ts:136`, :193).
         */
        const signed = await Promise.all(
          (p.fileUrls as string[]).map(key =>
            key.startsWith('uploads/')
              ? this.uploadService.generateDownloadUrl(key, 3600).catch((err) => {
                  this.logger.warn(`Failed to sign delivery proof key ${key}: ${err instanceof Error ? err.message : String(err)}`);
                  return null;
                })
              : Promise.resolve(key)
          ),
        );
        resolvedFileUrls = signed.filter((url): url is string => url !== null);
      }

      return {
        id: p.id,
        description: p.description,
        fileUrls: resolvedFileUrls,
        linkUrls: p.linkUrls,
        status: p.status,
        reviewWindowEnd: p.reviewWindowEnd,
        rejectionNote: p.rejectionNote,
        createdAt: p.createdAt,
      };
    }));

    return results;
  }

  async confirmDelivery(orderId: string, userId: string, proofId?: string): Promise<{ message: string }> {
    const order = await this.prisma.order.findFirst({ where: { orderId } });
    if (!order) throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
    if (order.buyerId !== userId) throw new ForbiddenException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Only buyer can confirm delivery' });
    if (order.status !== OrderStatus.IN_DELIVERY) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order is not in delivery' });
    }

    const proof = await this.prisma.deliveryProof.findFirst({
      where: proofId ? { id: proofId, orderId: order.id, status: 'SUBMITTED' } : { orderId: order.id, status: 'SUBMITTED' },
    });
    if (!proof) throw new NotFoundException({ code: ErrorCodes.DELIVERY_PROOF_NOT_FOUND, message: 'No pending delivery proof found' });

    // Proof review and escrow release are committed atomically by completeOrder.
    // If wallet settlement fails, the proof remains SUBMITTED and can be retried.
    await this.orderStateService.completeOrder(orderId, userId, proof.id);

    const completedOrder = await this.prisma.order.findUnique({
      where: { orderId },
      select: { buyerId: true, sellerId: true, title: true },
    });
    if (completedOrder) {
      this.runPostCommitBestEffort(async () => {
        await this.notificationQueue.enqueue({
          userId: completedOrder.sellerId,
          type: NotificationType.ORDER_COMPLETED,
          title: 'Order Completed',
          body: `Order "${completedOrder.title}" has been completed. Funds have been credited to your wallet.`,
          pushData: { type: 'ORDER_COMPLETED', orderId },
        });
        await this.notificationQueue.enqueue({
          userId: completedOrder.buyerId,
          type: NotificationType.WALLET_FUNDS_RELEASED,
          title: 'Escrow Released',
          body: `Escrow funds for order "${completedOrder.title}" have been released to the seller.`,
          pushData: { type: 'WALLET_FUNDS_RELEASED', orderId },
        });
      }, 'CONFIRM_DELIVERY_NOTIFICATION');
    }

    return { message: 'Delivery confirmed and order completed. Escrow funds have been released.' };
  }

  private static readonly MAX_REJECTION_COUNT = 5;

  async rejectDelivery(orderId: string, userId: string, note: string, proofId?: string): Promise<{ message: string; escalatedToDispute?: boolean }> {
    const normalizedNote = typeof note === 'string' ? note.trim() : '';
    if (normalizedNote.length < 10 || normalizedNote.length > 1000) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Rejection note must be between 10 and 1000 characters' });
    }
    const order = await this.prisma.order.findFirst({ where: { orderId } });
    if (!order) throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
    if (order.buyerId !== userId) throw new ForbiddenException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Only buyer can reject delivery' });
    if (order.status !== OrderStatus.IN_DELIVERY) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order is not in delivery' });
    }

    const proof = await this.prisma.deliveryProof.findFirst({
      where: proofId ? { id: proofId, orderId: order.id, status: 'SUBMITTED' } : { orderId: order.id, status: 'SUBMITTED' },
    });
    if (!proof) throw new NotFoundException({ code: ErrorCodes.DELIVERY_PROOF_NOT_FOUND, message: 'No pending delivery proof found' });

    let newRejectionTotal = 0;
    let shouldEscalate = false;

    /*
     * C-24: the dispute id is memoized across retry attempts rather than drawn inside the
     * transaction body.
     *
     * `getNextForPrefix` is a Redis `INCR` (`wallet-tx-serial.service.ts:59`), so it does NOT roll
     * back when PostgreSQL aborts the transaction. Drawing it inside the retried body would burn one
     * `dispute_serial` per attempt and leave gaps in the day's dispute sequence — the same hazard
     * that keeps the order serial above the loop in `order-links.service.ts` (C-23) and
     * `submitDispute` (C-18).
     *
     * Memoizing rather than hoisting unconditionally matters here because the draw is conditional:
     * escalation only happens on the 5th rejection and only when no dispute exists yet. A plain
     * hoist would burn a serial on all four earlier rejections too.
     */
    let escalationDisputeId: string | null = null;
    const nextDisputeId = async (): Promise<string> => {
      if (escalationDisputeId === null) {
        escalationDisputeId = generateDisputeId(await this.serialService.getNextForPrefix('dispute_serial'));
      }
      return escalationDisputeId;
    };

    await this.withSerializableRetry(() => this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`;
      const lockedOrder = await tx.order.findUnique({ where: { id: order.id } });
      if (!lockedOrder || lockedOrder.status !== OrderStatus.IN_DELIVERY || lockedOrder.buyerId !== userId) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order is no longer in delivery and cannot be rejected' });
      }
      const lockedProof = await tx.deliveryProof.findUnique({ where: { id: proof.id } });
      if (!lockedProof || lockedProof.status !== 'SUBMITTED') {
        throw new BadRequestException({ code: ErrorCodes.DELIVERY_PROOF_NOT_FOUND, message: 'Delivery proof has already been reviewed' });
      }
      const proofUpdated = await tx.deliveryProof.updateMany({
        where: { id: proof.id, status: 'SUBMITTED' },
        data: { status: 'REJECTED', reviewedAt: new Date(), rejectionNote: normalizedNote },
      });
      if (proofUpdated.count === 0) {
        throw new BadRequestException({ code: ErrorCodes.DELIVERY_PROOF_NOT_FOUND, message: 'Delivery proof has already been reviewed' });
      }

      newRejectionTotal = await tx.deliveryProof.count({ where: { orderId: order.id, status: 'REJECTED' } });
      shouldEscalate = newRejectionTotal >= DeliveryProofService.MAX_REJECTION_COUNT;

      if (shouldEscalate) {
        const existingDispute = await tx.dispute.findUnique({ where: { orderId: order.id } });
        if (!existingDispute) {
          const disputeId = await nextDisputeId();
          const now = new Date();
          const slaDeadlineAt = new Date(now.getTime() + DISPUTE_SLA_HOURS * 60 * 60 * 1000);

          await tx.dispute.create({
            data: {
              disputeId,
              orderId: order.id,
              initiatorUserId: userId,
              initiatedBy: DisputeInitiator.BUYER,
              buyerClaim: `Auto-escalated: delivery proof rejected ${newRejectionTotal} times. Last rejection: ${normalizedNote}`,
              buyerClaimedAt: now,
              status: DisputeStatus.OPEN,
              slaHours: DISPUTE_SLA_HOURS,
              slaDeadlineAt,
            },
          });

          const orderUpdated = await tx.order.updateMany({
            where: { id: order.id, status: OrderStatus.IN_DELIVERY },
            data: { status: OrderStatus.DISPUTED, disputedAt: now },
          });
          if (orderUpdated.count === 0) {
            throw new BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order status has already changed' });
          }

          await tx.orderStatusHistory.create({
            data: {
              orderId: order.id,
              fromStatus: OrderStatus.IN_DELIVERY,
              toStatus: OrderStatus.DISPUTED,
              changedBy: userId,
              changedByType: ActorType.BUYER,
              reason: `Auto-escalated to dispute after ${newRejectionTotal} delivery proof rejections`,
            },
          });

          await tx.user.update({
            where: { id: userId },
            data: { totalOrdersDisputed: { increment: 1 } },
          });
        }
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }), 'REJECT_DELIVERY_TX');

    this.auditLog.logUserAction({
      userId,
      action: UserAuditAction.ORDER_DELIVERED,
      entityType: 'DeliveryProof',
      entityId: proof.id,
      description: `Buyer rejected delivery proof for order ${orderId} (rejection ${newRejectionTotal}/${DeliveryProofService.MAX_REJECTION_COUNT}). Reason: ${note}`,
    });

    if (shouldEscalate) {
      this.logger.log(`Order ${orderId} auto-escalated to dispute after ${newRejectionTotal} delivery proof rejections`);

      this.runPostCommitBestEffort(() => this.notificationQueue.enqueue({
        userId: order.sellerId,
        type: NotificationType.DISPUTE_SUBMITTED,
        title: 'Dispute Auto-Escalated',
        body: `Order "${order.title || order.orderId}" has been automatically escalated to a dispute after ${newRejectionTotal} delivery proof rejections.`,
        pushData: { type: 'DISPUTE_SUBMITTED', orderId: order.orderId },
      }), 'REJECT_DELIVERY_ESCALATION_NOTIFICATION');

      return {
        message: `Delivery rejected. Maximum rejections (${DeliveryProofService.MAX_REJECTION_COUNT}) reached — order has been automatically escalated to a dispute.`,
        escalatedToDispute: true,
      };
    }

    this.runPostCommitBestEffort(() => this.notificationQueue.enqueue({
      userId: order.sellerId,
      type: NotificationType.ORDER_DELIVERED,
      title: 'Delivery Proof Rejected',
      body: `Buyer rejected delivery proof for order "${order.title || order.orderId}" (${newRejectionTotal}/${DeliveryProofService.MAX_REJECTION_COUNT}). Reason: ${note}`,
      pushData: { type: 'ORDER_DELIVERED', orderId: order.orderId },
    }), 'REJECT_DELIVERY_NOTIFICATION');

    return { message: 'Delivery rejected' };
  }
}
