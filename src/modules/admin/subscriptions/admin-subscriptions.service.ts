import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { MidtransService } from '../../payment/midtrans.service';
import { createPaginatedResponse } from '../../../common/dto/pagination.dto';
import { AuditAction, Prisma } from '@prisma/client';
import { toIdr } from '../../../common/utils/currency.util';
import * as ErrorCodes from '../../../common/constants/error-codes';

@Injectable()
export class AdminSubscriptionsService {
  private readonly logger = new Logger(AdminSubscriptionsService.name);

  constructor(
    private prisma: PrismaService,
    private auditLog: AuditLogService,
    private midtransService: MidtransService,
  ) {}

  async listSubscriptions(
    page: number,
    limit: number,
    status?: string,
    plan?: string,
  ): Promise<object> {
    const safePage = Math.max(1, Number.isFinite(page) ? Math.trunc(page) : 1);
    const safeLimit = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 20));
    const skip = (safePage - 1) * safeLimit;

    const where: Prisma.SubscriptionWhereInput = {};
    const normalizedStatus = status?.trim().toUpperCase();
    const normalizedPlan = plan?.trim().toUpperCase();
    if (normalizedStatus) {
      const validStatuses = ['ACTIVE', 'CANCELLED', 'EXPIRED', 'PENDING', 'SUSPENDED'];
      if (!validStatuses.includes(normalizedStatus)) {
        throw new BadRequestException({
          code: ErrorCodes.INVALID_STATUS,
          message: `Invalid subscription status: ${normalizedStatus}. Valid values: ${validStatuses.join(', ')}`,
        });
      }
      where.status = normalizedStatus as Prisma.EnumSubscriptionStatusFilter;
    }
    if (normalizedPlan) {
      const validPlans = ['MONTHLY', 'ANNUAL'];
      if (!validPlans.includes(normalizedPlan)) {
        throw new BadRequestException({
          code: ErrorCodes.INVALID_STATUS,
          message: `Invalid subscription plan: ${normalizedPlan}. Valid values: ${validPlans.join(', ')}`,
        });
      }
      where.plan = normalizedPlan as Prisma.EnumSubscriptionPlanFilter;
    }

    const [subscriptions, total] = await Promise.all([
      this.prisma.subscription.findMany({
        where,
        skip,
        take: safeLimit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              userId: true,
              username: true,
              fullName: true,
              email: true,
            },
          },
        },
      }),
      this.prisma.subscription.count({ where }),
    ]);

    const data = subscriptions.map(s => ({
      ...s,
      price: toIdr(s.price),
      feeSavingsUsed: toIdr(s.feeSavingsUsed),
      feeSavingsLimit: toIdr(s.feeSavingsLimit),
    }));

    return createPaginatedResponse(data, total, safePage, safeLimit);
  }

  async getSubscriptionDetail(subId: string): Promise<object> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: subId },
      include: {
        user: {
          select: {
            id: true,
            userId: true,
            username: true,
            fullName: true,
            email: true,
            isKahadePlus: true,
            subscriptionExpiresAt: true,
          },
        },
        paymentTx: true,
      },
    });

    if (!subscription) {
      throw new NotFoundException({
        code: ErrorCodes.SUBSCRIPTION_NOT_FOUND,
        message: 'Subscription not found',
      });
    }

    return {
      ...subscription,
      price: toIdr(subscription.price),
      feeSavingsUsed: toIdr(subscription.feeSavingsUsed),
      feeSavingsLimit: toIdr(subscription.feeSavingsLimit),
    };
  }

  async forceCancelSubscription(
    subId: string,
    adminId: string,
    ipAddress: string,
  ): Promise<{ message: string; subscriptionId: string; status: string }> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: subId },
    });

    if (!subscription) {
      throw new NotFoundException({
        code: ErrorCodes.SUBSCRIPTION_NOT_FOUND,
        message: 'Subscription not found',
      });
    }

    if (subscription.status !== 'ACTIVE' && subscription.status !== 'PENDING') {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_STATUS,
        message: 'Subscription is not active or pending',
      });
    }

    const updated = await this.prisma.$transaction(
      async tx => {
        const result = await tx.subscription.updateMany({
          where: { id: subId, status: { in: ['ACTIVE', 'PENDING'] } },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancelReason: 'Force cancelled by admin',
          },
        });
        if (result.count === 0) {
          throw new BadRequestException({
            code: ErrorCodes.INVALID_STATUS,
            message: 'Subscription is no longer active or pending',
          });
        }

        const sub = await tx.subscription.findUniqueOrThrow({ where: { id: subId } });
        const now = new Date();
        const remaining = await tx.subscription.findFirst({
          where: {
            userId: subscription.userId,
            id: { not: subId },
            status: { in: ['ACTIVE', 'CANCELLED', 'SUSPENDED'] },
            currentPeriodEnd: { gt: now },
          },
          orderBy: { currentPeriodEnd: 'desc' },
          select: { currentPeriodEnd: true },
        });

        await tx.user.update({
          where: { id: subscription.userId },
          data: {
            isKahadePlus: Boolean(remaining),
            subscriptionExpiresAt: remaining?.currentPeriodEnd ?? null,
          },
        });

        return sub;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    let paymentProviderSynced = false;
    let midtransOrderId: string | null = null;

    if (subscription.paymentTxId) {
      const paymentTx = await this.prisma.paymentTransaction.findUnique({
        where: { id: subscription.paymentTxId },
        select: { midtransOrderId: true },
      });
      midtransOrderId = paymentTx?.midtransOrderId ?? null;
    }

    if (midtransOrderId) {
      try {
        await this.midtransService.cancelTransaction(midtransOrderId);
        paymentProviderSynced = true;
        this.logger.log(
          `Payment provider notified: cancelled Midtrans transaction ${midtransOrderId} for subscription ${subId}`,
        );
      } catch (err) {
        this.logger.warn(
          `Failed to cancel Midtrans transaction ${midtransOrderId} for subscription ${subId}: ${(err as Error).message}. ` +
            `Manual reconciliation may be required.`,
        );
      }
    } else {
      this.logger.warn(
        `No linked Midtrans transaction found for subscription ${subId}. ` +
          `Payment provider could not be notified. Manual reconciliation may be required.`,
      );
    }

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'Subscription',
      targetId: subId,
      description: `Force cancelled subscription ${subId} for user ${subscription.userId}. Payment provider synced: ${paymentProviderSynced}.`,
      after: {
        paymentProviderSynced,
        midtransOrderId,
        note: paymentProviderSynced
          ? 'Midtrans transaction cancelled successfully.'
          : 'Payment provider sync failed or no linked transaction. Manual reconciliation may be required.',
      },
      ipAddress,
    });

    return {
      message: paymentProviderSynced
        ? 'Subscription cancelled successfully and payment provider notified.'
        : 'Subscription cancelled successfully. Warning: Payment provider sync failed — manual reconciliation may be required.',
      subscriptionId: updated.id,
      status: updated.status,
    };
  }
}
