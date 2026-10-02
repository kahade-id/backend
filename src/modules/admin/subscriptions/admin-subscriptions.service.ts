import { Injectable, NotFoundException, BadRequestException, ConflictException, ForbiddenException, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { MidtransService } from '../../payment/midtrans.service';
import { DanaDirectRefundService } from '../../no-wallet/dana-direct-refund.service';
import { createPaginatedResponse } from '../../../common/dto/pagination.dto';
import { AuditAction, Prisma } from '@prisma/client';
import { toIdr, toSen } from '../../../common/utils/currency.util';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { RedisService } from '../../../redis/redis.service';
import { VerificationBadgeService } from '../../users/verification-badge.service';
import { PLUS_FEE_WAIVER_QUOTA_IDR, SUBSCRIPTION_MONTHLY_PRICE, SUBSCRIPTION_YEARLY_PRICE } from '../../../common/constants/app.constants';
import { escapeLikePattern } from '../../../common/utils/search.util';
import { getWibMonthStart } from '../../../common/utils/date.util';
import { resolveUserInternalId } from '../common/resolve-user-id';
// SYS-B-402: dual control untuk pemberian nilai subscription di atas ambang.
import { ApprovalsService } from '../approvals/approvals.service';
import { DUAL_CONTROL_THRESHOLD_SEN } from '../approvals/dual-control.constants';

@Injectable()
export class AdminSubscriptionsService implements OnModuleInit {
  private readonly logger = new Logger(AdminSubscriptionsService.name);

  constructor(
    private prisma: PrismaService,
    private auditLog: AuditLogService,
    private midtransService: MidtransService,
    private danaDirectRefundService: DanaDirectRefundService,
    private redis: RedisService,
    private verificationBadgeService: VerificationBadgeService,
    // SYS-B-402: modul ini mengeksekusi MONEY_VALUE_GRANT yang disetujui
    // (ApprovalsModule @Global — tanpa import modul).
    private readonly approvals: ApprovalsService,
  ) {}

  onModuleInit(): void {
    this.approvals.registerExecutor('MONEY_VALUE_GRANT', async (ctx) => {
      const p = ctx.payload as Record<string, unknown>;
      // Jalur dual control: gate ambang dilewati (sudah dipenuhi saat propose
      // + approve oleh dua admin berbeda); validasi penuh tetap jalan.
      if (p.kind === 'SUBSCRIPTION_GRANT') {
        return this.performGrantSubscription(
          String(p.userId),
          p.plan as 'MONTHLY' | 'YEARLY',
          p.durationDays as number,
          typeof p.reason === 'string' ? p.reason : undefined,
          ctx.decidedBy,
          ctx.ipAddress,
        );
      }
      return this.performCreatePromoCode(
        {
          code: String(p.code),
          durationDays: p.durationDays as number,
          maxRedemptions: typeof p.maxRedemptions === 'number' ? p.maxRedemptions : null,
          assignedUserId: typeof p.assignedUserId === 'string' ? p.assignedUserId : null,
          expiresAt: typeof p.expiresAt === 'string' ? new Date(p.expiresAt) : null,
          note: typeof p.note === 'string' ? p.note : null,
        },
        ctx.decidedBy,
        ctx.ipAddress,
      );
    });
  }

  async listSubscriptions(
    page: number,
    limit: number,
    status?: string,
    plan?: string,
    search?: string,
  ): Promise<object> {
    const safePage = Math.max(1, Number.isFinite(page) ? Math.trunc(page) : 1);
    const safeLimit = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 20));
    const skip = (safePage - 1) * safeLimit;

    const where: Prisma.SubscriptionWhereInput = {};
    const normalizedStatus = status?.trim().toUpperCase();
    const normalizedPlan = plan?.trim().toUpperCase();
    if (normalizedStatus) {
      const validStatuses = ['ACTIVE', 'CANCELLED', 'EXPIRED', 'PENDING', 'SUSPENDED', 'PAUSED'];
      if (!validStatuses.includes(normalizedStatus)) {
        throw new BadRequestException({
          code: ErrorCodes.INVALID_STATUS,
          message: `Invalid subscription status: ${normalizedStatus}. Valid values: ${validStatuses.join(', ')}`,
        });
      }
      where.status = normalizedStatus as Prisma.EnumSubscriptionStatusFilter;
    }
    if (normalizedPlan) {
      const validPlans = ['MONTHLY', 'YEARLY'];
      if (!validPlans.includes(normalizedPlan)) {
        throw new BadRequestException({
          code: ErrorCodes.INVALID_STATUS,
          message: `Invalid subscription plan: ${normalizedPlan}. Valid values: ${validPlans.join(', ')}`,
        });
      }
      where.plan = normalizedPlan as Prisma.EnumSubscriptionPlanFilter;
    }
    const normalizedSearch = search?.trim();
    if (normalizedSearch) {
      const pattern = escapeLikePattern(normalizedSearch);
      where.user = {
        is: {
          OR: [
            { username: { contains: pattern, mode: 'insensitive' } },
            { email: { contains: pattern, mode: 'insensitive' } },
            { fullName: { contains: pattern, mode: 'insensitive' } },
            { userId: { contains: pattern, mode: 'insensitive' } },
          ],
        },
      };
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

    // Pemakaian kuota fee periode berjalan (Benefit 1 Kahade+).
    // SP-027: penulis usage memakai AWAL BULAN KALENDER WIB
    // (getWibMonthStart), bukan currentPeriodStart (awal periode billing) —
    // baca dengan kunci yang sama agar angka admin = angka aktual.
    let currentPeriodUsage: Record<string, unknown> | null = null;
    if (subscription.currentPeriodStart) {
      const monthStart = getWibMonthStart();
      const usage = await this.prisma.subscriptionUsage.findUnique({
        where: {
          subscriptionId_periodStart: {
            subscriptionId: subscription.id,
            periodStart: monthStart,
          },
        },
        select: { feeWaivedAmount: true, periodStart: true },
      });
      const waivedSen = usage?.feeWaivedAmount ?? BigInt(0);
      currentPeriodUsage = {
        periodStart: monthStart,
        periodEnd: subscription.currentPeriodEnd,
        feeWaivedAmount: toIdr(waivedSen),
        feeWaiverLimit: PLUS_FEE_WAIVER_QUOTA_IDR,
        feeWaiverRemaining: Math.max(0, PLUS_FEE_WAIVER_QUOTA_IDR - toIdr(waivedSen)),
      };
    }

    return {
      ...subscription,
      price: toIdr(subscription.price),
      feeSavingsUsed: toIdr(subscription.feeSavingsUsed),
      feeSavingsLimit: toIdr(subscription.feeSavingsLimit),
      currentPeriodUsage,
    };
  }

  async forceCancelSubscription(
    subId: string,
    adminId: string,
    ipAddress: string,
    reason?: string,
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
            cancelReason: reason?.trim() || 'Force cancelled by admin',
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

    // R2-B (audit): force-cancel flips the user's Plus entitlement immediately, but
    // orders.service keeps a 300 s `subscription_status:<userId>` cache. Without this
    // delete the user (or a refund-requesting buyer) could keep ordering at Plus rates
    // — or be charged Plus rates after losing them — for up to five minutes.
    await this.redis.del(`subscription_status:${subscription.userId}`).catch((err: unknown) =>
      this.logger.warn(`Failed to invalidate subscription status cache for ${subscription.userId}: ${err instanceof Error ? err.message : String(err)}`),
    );

    // Section 1: force-cancel bisa langsung mencabut badge "Kahade+" — invalidasi
    // cache badge post-commit supaya tidak ada jeda tampil.
    await this.verificationBadgeService.invalidate(subscription.userId);

    let paymentProviderSynced = false;
    let midtransOrderId: string | null = null;
    let danaRefunded = false;

    if (subscription.paymentTxId) {
      const paymentTx = await this.prisma.paymentTransaction.findUnique({
        where: { id: subscription.paymentTxId },
        select: { midtransOrderId: true, provider: true, status: true },
      });
      midtransOrderId = paymentTx?.midtransOrderId ?? null;
      // Misi tanpa-wallet: payment subscription via DANA direct yang SUDAH
      // terbayar di-refund ke metode bayar asal (idempoten).
      if (
        paymentTx?.provider === 'DANA' &&
        (paymentTx.status === 'SUCCESS' || paymentTx.status === 'PENDING')
      ) {
        try {
          const res = await this.danaDirectRefundService.refundAmount({
            paymentDbId: subscription.paymentTxId,
            reason: `Force cancel subscription ${subId} oleh admin — ${reason?.trim() || 'Force cancelled by admin'}`,
            idempotencyKey: `ADMIN_SUB_CANCEL:${subId}`,
          });
          danaRefunded = res.refunded;
          paymentProviderSynced = res.refunded;
          this.logger.log(
            `DANA refund untuk subscription ${subId}: refunded=${res.refunded} already=${'already' in res ? res.already : false}`,
          );
        } catch (err) {
          this.logger.warn(
            `Gagal DANA refund subscription ${subId}: ${(err as Error).message}. ` +
              `Manual reconciliation may be required.`,
          );
        }
      }
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
      description: `Force cancelled subscription ${subId} for user ${subscription.userId}. Payment provider synced: ${paymentProviderSynced}. DANA refunded: ${danaRefunded}.`,
      after: {
        paymentProviderSynced,
        midtransOrderId,
        danaRefunded,
        note: paymentProviderSynced
          ? 'Provider transaction cancelled/refunded successfully.'
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

  /**
   * POST /v1/admin/subscriptions/grant — buat subscription ACTIVE manual
   * (tanpa pembayaran). Dipakai untuk kompensasi / kemitraan / testing.
   */
  async grantSubscription(
    rawUserId: string,
    plan: 'MONTHLY' | 'YEARLY',
    durationDays: number,
    reason: string | undefined,
    adminId: string,
    ipAddress: string,
  ): Promise<object> {
    // SYS-B-402: grant = pemberian nilai uang (langganan gratis). Nilai
    // pro-rata harga plan; di atas ambang → wajib dual control.
    const planPriceIdr = plan === 'MONTHLY' ? SUBSCRIPTION_MONTHLY_PRICE : SUBSCRIPTION_YEARLY_PRICE;
    const planDays = plan === 'MONTHLY' ? 30 : 365;
    const valueSen = toSen(Math.round((planPriceIdr * durationDays) / planDays));
    if (valueSen > DUAL_CONTROL_THRESHOLD_SEN) {
      throw new ForbiddenException({
        code: ErrorCodes.DUAL_CONTROL_REQUIRED,
        message:
          'Nilai grant subscription di atas Rp1.000.000 wajib dual control ' +
          '(usulkan via POST /v1/admin/approvals/propose dengan actionType MONEY_VALUE_GRANT, kind SUBSCRIPTION_GRANT)',
      });
    }
    return this.performGrantSubscription(rawUserId, plan, durationDays, reason, adminId, ipAddress);
  }

  /**
   * Inti grant subscription — dipakai grantSubscription (jalur langsung,
   * setelah gate ambang) dan executor MONEY_VALUE_GRANT (jalur dual control;
   * guard sudah dipenuhi saat propose + approve oleh dua admin berbeda).
   */
  async performGrantSubscription(
    rawUserId: string,
    plan: 'MONTHLY' | 'YEARLY',
    durationDays: number,
    reason: string | undefined,
    adminId: string,
    ipAddress: string,
  ): Promise<object> {
    // ADM-202: terima ID publik (USR-…) maupun cuid internal.
    const internalUserId = await resolveUserInternalId(this.prisma, rawUserId);
    const user = await this.prisma.user.findUnique({
      where: { id: internalUserId },
      select: { id: true, kahadePlusSince: true },
    });
    if (!user) {
      throw new NotFoundException({
        code: ErrorCodes.USER_NOT_FOUND,
        message: 'User tidak ditemukan',
      });
    }

    const now = new Date();
    const existing = await this.prisma.subscription.findFirst({
      where: {
        userId: internalUserId,
        status: { in: ['ACTIVE', 'CANCELLED', 'SUSPENDED', 'PAUSED'] },
        currentPeriodEnd: { gt: now },
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException({
        code: ErrorCodes.SUBSCRIPTION_ALREADY_ACTIVE,
        message: 'User sudah memiliki periode subscription yang masih berjalan',
      });
    }

    const periodEnd = new Date(now);
    periodEnd.setDate(periodEnd.getDate() + durationDays);

    const subscription = await this.prisma.$transaction(
      async tx => {
        const created = await tx.subscription.create({
          data: {
            userId: internalUserId,
            plan,
            status: 'ACTIVE',
            price: BigInt(0),
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
            isAutoRenew: false,
            lastPaymentAt: null,
            nextPaymentAt: periodEnd,
            cancelReason: null,
          },
        });
        await tx.user.update({
          where: { id: internalUserId },
          data: {
            isKahadePlus: true,
            subscriptionExpiresAt: periodEnd,
            ...(user.kahadePlusSince ? {} : { kahadePlusSince: now }),
          },
        });
        return created;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    await this.redis.del(`subscription_status:${internalUserId}`).catch((err: unknown) =>
      this.logger.warn(`Failed to invalidate subscription status cache for ${internalUserId}: ${err instanceof Error ? err.message : String(err)}`),
    );
    await this.verificationBadgeService.invalidate(internalUserId);

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'Subscription',
      targetId: subscription.id,
      description: `Granted ${plan} subscription (${durationDays} days) to user ${internalUserId}. Reason: ${reason?.trim() || '-'}`,
      ipAddress,
    });

    return {
      ...subscription,
      price: toIdr(subscription.price),
      feeSavingsUsed: toIdr(subscription.feeSavingsUsed),
      feeSavingsLimit: toIdr(subscription.feeSavingsLimit),
    };
  }

  // ============================================================
  // KODE PROMO GRATIS (keputusan produk 2026-09-26)
  // Admin membuat kode untuk user pilihan: durasi bebas (3/7/14/30/365 hari),
  // sekali pakai (default) atau batas pakai tertentu, opsional dikunci ke user.
  // ============================================================

  async createPromoCode(
    input: {
      code: string;
      durationDays: number;
      maxRedemptions?: number | null;
      assignedUserId?: string | null;
      expiresAt?: Date | null;
      note?: string | null;
    },
    adminId: string,
    ipAddress: string,
  ): Promise<object> {
    // SYS-B-402: kode promo = penciptaan liabilitas (durasi gratis × batas
    // pakai). Nilai pro-rata harga bulanan; di atas ambang → dual control.
    const redemptions = input.maxRedemptions ?? 1;
    const valueSen = toSen(Math.round((SUBSCRIPTION_MONTHLY_PRICE / 30) * input.durationDays * redemptions));
    if (valueSen > DUAL_CONTROL_THRESHOLD_SEN) {
      throw new ForbiddenException({
        code: ErrorCodes.DUAL_CONTROL_REQUIRED,
        message:
          'Nilai kode promo di atas Rp1.000.000 wajib dual control ' +
          '(usulkan via POST /v1/admin/approvals/propose dengan actionType MONEY_VALUE_GRANT, kind PROMO_CODE_CREATE)',
      });
    }
    return this.performCreatePromoCode(input, adminId, ipAddress);
  }

  /**
   * Inti pembuatan kode promo — dipakai createPromoCode (jalur langsung,
   * setelah gate ambang) dan executor MONEY_VALUE_GRANT (jalur dual control).
   */
  async performCreatePromoCode(
    input: {
      code: string;
      durationDays: number;
      maxRedemptions?: number | null;
      assignedUserId?: string | null;
      expiresAt?: Date | null;
      note?: string | null;
    },
    adminId: string,
    ipAddress: string,
  ): Promise<object> {
    const code = input.code.trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,32}$/.test(code)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Kode promo 3-32 karakter: A-Z, 0-9, _,-' });
    }
    if (!Number.isInteger(input.durationDays) || input.durationDays < 1 || input.durationDays > 366) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'durationDays harus 1-366 hari' });
    }
    if (input.maxRedemptions !== undefined && input.maxRedemptions !== null) {
      if (!Number.isInteger(input.maxRedemptions) || input.maxRedemptions < 1) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'maxRedemptions minimal 1' });
      }
    }
    if (input.assignedUserId) {
      // ADM-202 (pola sama): terima ID publik maupun cuid internal.
      const assignedInternalId = await resolveUserInternalId(this.prisma, input.assignedUserId);
      input = { ...input, assignedUserId: assignedInternalId };
    }

    try {
      const promo = await this.prisma.subscriptionPromoCode.create({
        data: {
          code,
          durationDays: input.durationDays,
          maxRedemptions: input.maxRedemptions ?? 1,
          assignedUserId: input.assignedUserId ?? null,
          expiresAt: input.expiresAt ?? null,
          createdBy: adminId,
          note: input.note ?? null,
        },
      });
      this.auditLog.logAdminAction({
        adminId,
        action: AuditAction.ADMIN_ACTION,
        targetType: 'SubscriptionPromoCode',
        targetId: promo.id,
        description: `Kode promo ${code} dibuat (${input.durationDays} hari, maks ${input.maxRedemptions ?? 1}x pakai)`,
        ipAddress,
      });
      return promo;
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Kode promo sudah dipakai' });
      }
      throw err;
    }
  }

  async listPromoCodes(page: number, limit: number): Promise<object> {
    const [total, items] = await this.prisma.$transaction([
      this.prisma.subscriptionPromoCode.count(),
      this.prisma.subscriptionPromoCode.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { assignedUser: { select: { id: true, username: true } } },
      }),
    ]);
    return createPaginatedResponse(items, total, page, limit);
  }

  async setPromoCodeStatus(id: string, active: boolean, adminId: string, ipAddress: string): Promise<object> {
    const promo = await this.prisma.subscriptionPromoCode.findUnique({ where: { id } });
    if (!promo) {
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Kode promo tidak ditemukan' });
    }
    const updated = await this.prisma.subscriptionPromoCode.update({
      where: { id },
      data: { status: active ? 'ACTIVE' : 'DISABLED' },
    });
    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'SubscriptionPromoCode',
      targetId: id,
      description: `Kode promo ${promo.code} ${active ? 'diaktifkan' : 'dinonaktifkan'}`,
      ipAddress,
    });
    return updated;
  }
}
