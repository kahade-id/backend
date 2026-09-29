import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import {
  Subscription,
  SubscriptionPlan,
  SubscriptionStatus,
  WalletTransactionType,
  WalletTransactionStatus,
  UserAuditAction,
  Prisma,
  Campaign,
  CampaignStatus,
  CampaignType,
  MembershipRank,
  KycStatus,
  PaymentMethod,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from '@prisma/client';
import { createPaginatedResponse, PaginatedResponse } from '../../common/dto/pagination.dto';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { WalletService } from '../wallet/wallet.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import { VerificationBadgeService } from '../users/verification-badge.service';
import { generateWalletTxId, generatePaymentTxId } from '../../common/utils/id-generator.util';
import { FlashQrisService, FlashQrisPayment } from '../payment/flash-qris.service';
import { DanaPaymentService } from '../payment/dana/dana-payment.service';
import { WalletModeService } from '../wallet-mode/wallet-mode.service';
import { DanaDirectRefundService } from '../no-wallet/dana-direct-refund.service';
import { DanaDirectPayKind } from '../no-wallet/dto/dana-direct-pay.dto';
import {
  generateDanaPartnerReferenceNo,
  DANA_DIRECT_VA_BANKS,
} from '../no-wallet/dana-direct-payment.service';
import * as ErrorCodes from '../../common/constants/error-codes';
import { toIdr, toSen, percentToBpsBigInt } from '../../common/utils/currency.util';
import { getWibMonthStart } from '../../common/utils/date.util';
import { SUBSCRIPTION_PLANS_CACHE } from '../../common/constants/redis-keys';
import { KAHADE_PLUS_BENEFITS, SubscriptionBenefit } from './subscription-benefits.constant';
import {
  SUBSCRIPTION_MONTHLY_PRICE,
  SUBSCRIPTION_YEARLY_PRICE,
  PLUS_FEE_WAIVER_QUOTA_SEN,
  SHOWCASE_MAX_IMAGES,
  SHOWCASE_MAX_IMAGES_SUBSCRIBER,
} from '../../common/constants/app.constants';

const SUBSCRIPTION_PLANS_TTL = 300;

/**
 * WF-023: dilempar di dalam $transaction aktivasi untuk me-rollback total
 * bila klaim atomik gagal (webhook konkuren sudah memproses). Bukan error
 * operasional — ditangkap dan diperlakukan sebagai "sudah diproses".
 */
class SubscriptionActivationRaceError extends Error {
  constructor(paymentTxId: string) {
    super(`Subscription activation race lost for payment ${paymentTxId}`);
    this.name = 'SubscriptionActivationRaceError';
  }
}

/**
 * Validasi bankCode VA → union literal yang diterima DANA.
 * Fail-closed: bank di luar daftar DANA ditolak.
 */
function assertVaBank(bankCode: string | undefined): (typeof DANA_DIRECT_VA_BANKS)[number] {
  const upper = (bankCode ?? '').toUpperCase();
  if (!(DANA_DIRECT_VA_BANKS as readonly string[]).includes(upper)) {
    throw new BadRequestException({
      code: 'DANA_VA_BANK_REQUIRED',
      message: `bankCode wajib untuk VA — pilihan: ${DANA_DIRECT_VA_BANKS.join(', ')}`,
    });
  }
  return upper as (typeof DANA_DIRECT_VA_BANKS)[number];
}

const RANK_ORDER: MembershipRank[] = [MembershipRank.BRONZE, MembershipRank.SILVER, MembershipRank.GOLD, MembershipRank.PLATINUM, MembershipRank.DIAMOND];

const PLAN_METADATA: Record<SubscriptionPlan, { durationDays: number; label: string }> = {
  MONTHLY: { durationDays: 30, label: 'Kahade Plus Monthly' },
  YEARLY: { durationDays: 365, label: 'Kahade Plus Yearly' },
};

// Fitur early-access Kahade+ (Benefit 6). Daftar ini yang diekspos di GET /me.
export const EARLY_ACCESS_FEATURES = ['patungan', 'split-bill'] as const;
export type EarlyAccessFeature = (typeof EARLY_ACCESS_FEATURES)[number];

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);
  private readonly planPricing: Record<
    SubscriptionPlan,
    { price: bigint; durationDays: number; label: string }
  >;

  constructor(
    private prisma: PrismaService,
    private walletTxSerialService: WalletTxSerialService,
    private walletService: WalletService,
    private configService: ConfigService,
    private redis: RedisService,
    private auditLogService: AuditLogService,
    private verificationBadgeService: VerificationBadgeService,
    private flashQrisService: FlashQrisService,
    private danaPaymentService: DanaPaymentService,
    private walletMode: WalletModeService,
    private danaDirectRefundService: DanaDirectRefundService,
  ) {
    const monthlyPriceSen =
      this.configService.get<number>('app.subscriptionMonthlyPriceSen') ??
      SUBSCRIPTION_MONTHLY_PRICE * 100;
    const yearlyPriceSen =
      this.configService.get<number>('app.subscriptionYearlyPriceSen') ??
      SUBSCRIPTION_YEARLY_PRICE * 100;
    this.planPricing = {
      MONTHLY: { price: BigInt(monthlyPriceSen), ...PLAN_METADATA.MONTHLY },
      YEARLY: { price: BigInt(yearlyPriceSen), ...PLAN_METADATA.YEARLY },
    };
  }

  /**
   * Section 1(c): `kahadePlusSince` = tanggal PERTAMA kali user jadi Plus.
   * Dikembalikan sebagai patch object supaya bisa di-spread ke `tx.user.update`.
   * Kalau sudah terisi, tidak diubah sama sekali.
   */
  private async buildKahadePlusSinceData(
    tx: Prisma.TransactionClient,
    userId: string,
    since: Date,
  ): Promise<{ kahadePlusSince?: Date }> {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { kahadePlusSince: true } });
    return user?.kahadePlusSince ? {} : { kahadePlusSince: since };
  }

  private async isDormantUser(userId: string, totalOrdersCompleted: number, days: number): Promise<boolean> {
    if (totalOrdersCompleted <= 0) return false;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const recentCompleted = await this.prisma.order.count({
      where: {
        status: 'COMPLETED',
        deletedAt: null,
        completedAt: { gte: cutoff },
        OR: [{ buyerId: userId }, { sellerId: userId }],
      },
    });
    return recentCompleted === 0;
  }

  private isRankEligible(current: MembershipRank, minimum?: MembershipRank | null): boolean {
    if (!minimum) return true;
    return RANK_ORDER.indexOf(current) >= RANK_ORDER.indexOf(minimum);
  }

  /**
   * Kode promo GRATIS dari admin (SubscriptionPromoCode).
   *
   * Keputusan produk 2026-09-26: admin membuat kode untuk user pilihan dengan
   * durasi bebas (3/7/14/30 hari bahkan 1 tahun). Satu kode default sekali
   * pakai (maxRedemptions=1), bisa diatur admin; bisa dikunci ke user tertentu
   * (assignedUserId). Return null bila tidak ada kode / bukan kode promo gratis
   * (pemanggil lanjut cek campaign discount).
   */
  private async resolvePromoCodeGrant(
    userId: string,
    promoCode: string | undefined,
  ): Promise<{ id: string; code: string; durationDays: number; maxRedemptions: number | null } | null> {
    const normalized = promoCode?.trim().toUpperCase();
    if (!normalized) return null;
    if (!/^[A-Z0-9_-]{3,32}$/.test(normalized)) return null;

    const promo = await this.prisma.subscriptionPromoCode.findUnique({
      where: { code: normalized },
    });
    if (!promo) return null;
    if (promo.status !== 'ACTIVE') {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Promo code is not active' });
    }
    if (promo.expiresAt && promo.expiresAt <= new Date()) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Promo code has expired' });
    }
    if (promo.assignedUserId && promo.assignedUserId !== userId) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Promo code is not assigned to your account' });
    }
    if (promo.maxRedemptions !== null && promo.currentRedemptions >= promo.maxRedemptions) {
      throw new BadRequestException({ code: ErrorCodes.VOUCHER_USAGE_LIMIT_REACHED, message: 'Promo code has reached its maximum redemptions' });
    }
    if (promo.durationDays < 1 || promo.durationDays > 366) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Promo code has invalid duration' });
    }
    return { id: promo.id, code: promo.code, durationDays: promo.durationDays, maxRedemptions: promo.maxRedemptions };
  }

  private async resolveSubscriptionCampaign(
    userId: string,
    promoCode: string | undefined,
    priceSen: bigint,
  ): Promise<{ campaign: Campaign | null; discountSen: bigint }> {
    const normalized = promoCode?.trim().toUpperCase();
    if (!normalized) return { campaign: null, discountSen: BigInt(0) };
    if (!/^[A-Z0-9_-]{3,32}$/.test(normalized)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Promo code is invalid' });
    }

    const now = new Date();
    const campaign = await this.prisma.campaign.findFirst({
      where: {
        promoCode: normalized,
        type: CampaignType.SUBSCRIPTION_DISCOUNT,
        status: CampaignStatus.ACTIVE,
        startsAt: { lte: now },
        endsAt: { gt: now },
      },
    });
    if (!campaign) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Subscription promo code is not active' });
    }
    if (campaign.maxRedemptions !== null && campaign.currentRedemptions >= campaign.maxRedemptions) {
      throw new BadRequestException({ code: ErrorCodes.VOUCHER_USAGE_LIMIT_REACHED, message: 'Promo code has reached its maximum redemptions' });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { membershipRank: true, totalOrdersCompleted: true },
    });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    if (!this.isRankEligible(user.membershipRank, campaign.targetMinRank)) {
      throw new BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: 'Promo code is not available for your membership rank' });
    }
    if (campaign.targetNewUserOnly && user.totalOrdersCompleted > 0) {
      throw new BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: 'Promo code is only available for new users' });
    }
    if (campaign.targetDormantDays !== null && !(await this.isDormantUser(userId, user.totalOrdersCompleted, campaign.targetDormantDays))) {
      throw new BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: 'Promo code is only available for dormant users' });
    }

    let discountSen = BigInt(0);
    if (campaign.discountValue !== null) {
      discountSen = campaign.discountValue;
    } else if (campaign.discountPercent !== null) {
      // SP-008: konversi persen→bps eksak (string-based), bukan float
      // Math.round(Number(x) * 100) yang bisa meleset 1 bps.
      const percentBps = percentToBpsBigInt(campaign.discountPercent);
      discountSen = (priceSen * percentBps) / BigInt(10_000);
      if (campaign.maxDiscount !== null && discountSen > campaign.maxDiscount) discountSen = campaign.maxDiscount;
    }
    if (discountSen > priceSen) discountSen = priceSen;
    return { campaign, discountSen };
  }

  async getStatus(userId: string): Promise<Record<string, unknown>> {
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        userId,
        status: {
          in: [
            SubscriptionStatus.ACTIVE,
            SubscriptionStatus.CANCELLED,
            SubscriptionStatus.SUSPENDED,
            SubscriptionStatus.PAUSED,
          ],
        },
        currentPeriodEnd: { gt: new Date() },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    if (!subscription) {
      return {
        isActive: false,
        plan: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        feeSavingsUsed: 0,
        feeSavingsLimit: 0,
        feeSavingsRemaining: 0,
        isAutoRenew: false,
      };
    }

    const feeSavingsRemaining =
      subscription.feeSavingsLimit > subscription.feeSavingsUsed
        ? subscription.feeSavingsLimit - subscription.feeSavingsUsed
        : BigInt(0);
    const isInGracePeriod = subscription.status === SubscriptionStatus.SUSPENDED;
    const isPaused = subscription.status === SubscriptionStatus.PAUSED;

    return {
      isActive: !isInGracePeriod && !isPaused,
      isInGracePeriod,
      isPaused,
      plan: subscription.plan,
      status: subscription.status,
      cancelledAt: subscription.cancelledAt,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      pausedAt: subscription.pausedAt,
      resumeAt: subscription.resumeAt,
      feeSavingsUsed: toIdr(subscription.feeSavingsUsed),
      feeSavingsLimit: toIdr(subscription.feeSavingsLimit),
      feeSavingsRemaining: toIdr(feeSavingsRemaining),
      isAutoRenew: subscription.isAutoRenew,
      lastPaymentAt: subscription.lastPaymentAt,
      nextPaymentAt: subscription.nextPaymentAt,
      createdAt: subscription.createdAt,
    };
  }

  /**
   * SOURCE OF TRUTH status Kahade+ (spek Kahade+).
   *
   * true hanya jika user punya subscription dengan status ACTIVE dan
   * currentPeriodEnd > now. Subscription PAUSED / CANCELLED / SUSPENDED /
   * EXPIRED tidak dihitung aktif. Semua benefit (fee waiver, grey badge,
   * prioritas support, early access, dst.) WAJIB memakai method ini —
   * jangan baca kolom isKahadePlus / subscriptionExpiresAt langsung.
   */
  async isActive(userId: string): Promise<boolean> {
    return (await this.getSubscription(userId)) !== null;
  }

  /**
   * Mengembalikan subscription aktif user (status ACTIVE, periode berjalan),
   * atau null bila tidak ada. Pasangan dari isActive() untuk kasus yang butuh
   * datanya, bukan hanya boolean.
   */
  async getSubscription(userId: string): Promise<Subscription | null> {
    const now = new Date();
    return this.prisma.subscription.findFirst({
      where: {
        userId,
        status: SubscriptionStatus.ACTIVE,
        currentPeriodEnd: { gt: now },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  /**
   * EO-007: subscription yang berhak atas benefit Plus — ACTIVE, atau
   * CANCELLED yang masih dalam masa berbayar (cancel-at-period-end,
   * keputusan produk 2026-09-26). Selaras dengan eligibilitas tarif Plus di
   * orders.service (estimate & create memakai [ACTIVE, CANCELLED]).
   * Dipakai jalur waiver (waiveFeeIfEligible, estimateWaiverAmount,
   * getFeeWaivedThisPeriod).
   */
  private findBenefitSubscription(userId: string): Promise<Subscription | null> {
    return this.prisma.subscription.findFirst({
      where: {
        userId,
        status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.CANCELLED] },
        currentPeriodEnd: { gt: new Date() },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  /**
   * Benefit 2 — Centang Abu: true jika subscriber aktif DAN KYC lengkap
   * (kycStatus APPROVED + email terverifikasi + no HP terverifikasi +
   * alamat terisi). Sumber status: kolom denormalisasi di tabel users
   * (di-sync oleh KycService saat approve/reject).
   */
  async hasGreyBadge(userId: string): Promise<boolean> {
    if (!(await this.isActive(userId))) return false;
    return this.isKycComplete(userId);
  }

  private async isKycComplete(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        kycStatus: true,
        emailVerified: true,
        phoneVerified: true,
        address: true,
      },
    });
    if (!user) return false;
    return (
      user.kycStatus === KycStatus.APPROVED &&
      user.emailVerified === true &&
      user.phoneVerified === true &&
      user.address != null &&
      user.address.trim().length > 0
    );
  }

  /**
   * Benefit 6 — Akses Awal: true jika subscriber aktif.
   */
  async isFeatureEnabled(userId: string, feature: EarlyAccessFeature): Promise<boolean> {
    if (!EARLY_ACCESS_FEATURES.includes(feature)) return false;
    return this.isActive(userId);
  }

  /**
   * Benefit 7 — Custom Etalase: batas gambar per item showcase berbasis
   * subscription. 18 untuk subscriber aktif, 8 untuk yang lain.
   */
  async getMaxShowcaseImages(userId: string): Promise<number> {
    return (await this.isActive(userId)) ? SHOWCASE_MAX_IMAGES_SUBSCRIBER : SHOWCASE_MAX_IMAGES;
  }

  /**
   * Awal bulan kalender berjalan dalam WIB (UTC+7), sebagai Date UTC.
   * Kuota fee waiver Kahade+ direset tiap bulan kalender — termasuk untuk
   * paket YEARLY (bukan sekali per periode billing tahunan).
   */
  private getQuotaMonthStart(now: Date = new Date()): Date {
    // SP-027: delegasi ke util bersama agar kunci = pembaca admin.
    return getWibMonthStart(now);
  }

  /**
   * Benefit 1 — Tanpa Biaya Transaksi.
   *
   * Jika user subscriber aktif dan sisa kuota bulan kalender berjalan (WIB) > 0,
   * fee dibebaskan SEBESAR sisa kuota (return fee setelah dikurangi waiver;
   * 0n = bebas penuh, feeAmountSen = tanpa waiver). Pencatatan usage memakai
   * SELECT FOR UPDATE di dalam transaksi pemanggil sehingga dua order
   * konkuren tidak bisa membebaskan melebihi kuota (race-safe).
   *
   * Kuota Rp 990.000 (99.000.000 sen) per bulan kalender; reset tiap awal
   * bulan (satu baris SubscriptionUsage per pasangan subscription+monthStart).
   *
   * Dipanggil di titik kalkulasi platform fee (orders.service createOrder).
   * `client` diisi tx Prisma pemanggil agar pencatatan usage ikut transaksi order.
   */
  async waiveFeeIfEligible(
    userId: string,
    feeAmountSen: bigint,
    client?: Prisma.TransactionClient,
  ): Promise<bigint> {
    if (feeAmountSen <= BigInt(0)) return feeAmountSen;
    const db = (client ?? this.prisma) as Prisma.TransactionClient;

    const subscription = await db.subscription.findFirst({
      where: {
        userId,
        // EO-007: CANCELLED = cancel-at-period-end (keputusan produk 2026-09-26):
        // user sudah membayar s/d currentPeriodEnd sehingga tetap berhak atas
        // benefit Plus — selaras dengan eligibilitas tarif di orders.service
        // (estimate & create memakai [ACTIVE, CANCELLED]).
        status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.CANCELLED] },
        currentPeriodEnd: { gt: new Date() },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    if (!subscription) return feeAmountSen;

    const quotaSen = BigInt(
      this.configService.get<number>('app.plusFeeWaiverQuotaSen') ?? PLUS_FEE_WAIVER_QUOTA_SEN,
    );
    // Periode kuota = bulan kalender WIB, BUKAN periode billing subscription.
    const periodStart = this.getQuotaMonthStart();

    const usage = await db.subscriptionUsage.upsert({
      where: {
        subscriptionId_periodStart: { subscriptionId: subscription.id, periodStart },
      },
      create: { subscriptionId: subscription.id, periodStart, feeWaivedAmount: BigInt(0) },
      update: {},
      select: { id: true },
    });

    // Kunci baris usage dalam transaksi ini — order konkuren antre di sini,
    // sehingga keputusan waiver selalu memakai angka sisa kuota terkini.
    const locked = await db.$queryRaw<Array<{ feeWaivedAmount: bigint }>>`
      SELECT "feeWaivedAmount" FROM "subscription_usages"
      WHERE "id" = ${usage.id} FOR UPDATE
    `;
    const waivedSoFar = locked[0]?.feeWaivedAmount ?? BigInt(0);
    const remaining = quotaSen - waivedSoFar;
    if (remaining <= BigInt(0)) return feeAmountSen;

    // Waiver parsial bila sisa kuota < fee: user tetap dapat potongan sebesar
    // sisa kuota, bukan all-or-nothing.
    const waived = feeAmountSen < remaining ? feeAmountSen : remaining;
    await db.subscriptionUsage.update({
      where: { id: usage.id },
      data: { feeWaivedAmount: waivedSoFar + waived },
    });

    this.logger.log(
      `Plus fee waiver: user ${userId} dibebaskan ${waived} sen (sisa kuota ${remaining} sen, bulan ${periodStart.toISOString()})`,
    );
    return feeAmountSen - waived;
  }

  /**
   * Total fee yang sudah dibebaskan pada bulan kalender berjalan (WIB),
   * dalam sen. Periode kuota = bulan kalender, bukan periode billing.
   */
  async getFeeWaivedThisPeriod(userId: string): Promise<bigint> {
    const subscription = await this.findBenefitSubscription(userId);
    if (!subscription) return BigInt(0);
    const usage = await this.prisma.subscriptionUsage.findUnique({
      where: {
        subscriptionId_periodStart: {
          subscriptionId: subscription.id,
          periodStart: this.getQuotaMonthStart(),
        },
      },
      select: { feeWaivedAmount: true },
    });
    return usage?.feeWaivedAmount ?? BigInt(0);
  }

  /**
   * WF-019: estimasi READ-ONLY berapa fee yang akan dibebaskan untuk order
   * berikutnya — TANPA menulis/menghabiskan kuota (tidak seperti
   * waiveFeeIfEligible yang mencatat usage di dalam transaksi order).
   *
   * Dipakai endpoint estimasi calculate-fee agar preview = yang dibayar.
   * Mengembalikan 0n bila tidak eligible (tidak ada subscription aktif /
   * kuota habis). Waiver parsial bila sisa kuota < fee (cerminan
   * waiveFeeIfEligible).
   */
  async estimateWaiverAmount(userId: string, feeAmountSen: bigint): Promise<bigint> {
    if (feeAmountSen <= BigInt(0)) return BigInt(0);
    const subscription = await this.findBenefitSubscription(userId);
    if (!subscription) return BigInt(0);
    const quotaSen = BigInt(
      this.configService.get<number>('app.plusFeeWaiverQuotaSen') ?? PLUS_FEE_WAIVER_QUOTA_SEN,
    );
    const waivedSoFar = await this.getFeeWaivedThisPeriod(userId);
    const remaining = quotaSen - waivedSoFar;
    if (remaining <= BigInt(0)) return BigInt(0);
    return feeAmountSen < remaining ? feeAmountSen : remaining;
  }

  /**
   * GET /v1/subscriptions/me — ringkasan status Kahade+ untuk user.
   */
  async getMe(userId: string): Promise<Record<string, unknown>> {
    const subscription = await this.getSubscription(userId);
    const active = subscription !== null;
    const feeWaivedSen = active ? await this.getFeeWaivedThisPeriod(userId) : BigInt(0);
    const quotaSen = BigInt(
      this.configService.get<number>('app.plusFeeWaiverQuotaSen') ?? PLUS_FEE_WAIVER_QUOTA_SEN,
    );
    const earlyAccess: Record<string, boolean> = {};
    for (const feature of EARLY_ACCESS_FEATURES) {
      earlyAccess[feature] = active;
    }
    return {
      isActive: active,
      plan: subscription?.plan ?? null,
      status: subscription?.status ?? null,
      currentPeriodStart: subscription?.currentPeriodStart ?? null,
      currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
      // Cancel-at-period-end (2026-09-26): true bila user membatalkan tapi
      // benefit masih berjalan sampai currentPeriodEnd.
      cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
      feeWaivedThisPeriod: toIdr(feeWaivedSen),
      feeWaiverLimit: toIdr(quotaSen),
      showGreyBadge: active ? await this.isKycComplete(userId) : false,
      earlyAccess,
    };
  }

  /**
   * Berlangganan Kahade+.
   *
   * Keputusan produk 2026-09-26:
   * - Trial DIHAPUS — tidak ada lagi `useTrial`.
   * - Kode promo: (a) kode promo GRATIS dari admin (SubscriptionPromoCode)
   *   → langganan gratis dengan durasi hari yang ditentukan admin, tanpa PIN;
   *   (b) kode campaign SUBSCRIPTION_DISCOUNT → diskon harga (tetap bayar via
   *   wallet + PIN bila masih ada sisa harga).
   * - Berlangganan TIDAK mensyaratkan KYC.
   */
  async subscribe(
    userId: string,
    plan: SubscriptionPlan,
    pin?: string,
    ip?: string,
    options: { promoCode?: string } = {},
  ): Promise<Subscription> {
    const planInfo = this.planPricing[plan];
    if (!planInfo) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Invalid subscription plan',
      });
    }

    // CW-003: expire PENDING basi dulu agar tidak memblokir subscribe ulang.
    await this.expireStalePendingSubscriptions(userId);

    // Kode promo gratis dari admin — dicek dulu sebelum campaign discount.
    const promoGrant = await this.resolvePromoCodeGrant(userId, options.promoCode);

    const campaignDiscount = promoGrant
      ? { campaign: null, discountSen: BigInt(0) }
      : await this.resolveSubscriptionCampaign(userId, options.promoCode, planInfo.price);
    const effectivePrice = promoGrant
      ? BigInt(0)
      : planInfo.price - campaignDiscount.discountSen;
    if (effectivePrice < BigInt(0)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid subscription price after discount' });
    }
    if (effectivePrice > BigInt(0)) {
      // Misi tanpa-wallet (BI-safe): debit wallet MATI saat kill-switch mati.
      // Berbayar harus lewat DANA langsung (POST /v1/subscriptions/subscribe-dana).
      if (!this.walletMode.isWalletEnabled()) {
        throw new BadRequestException({
          code: 'WALLET_DISABLED_USE_DANA',
          message: 'Wallet payments are disabled — use subscribe-dana',
        });
      }
      if (!pin) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Wallet PIN is required for paid subscriptions' });
      }
      await this.walletService.verifyPin(userId, pin, ip);
    }

    const walletTxSerial = effectivePrice > BigInt(0) ? await this.walletTxSerialService.getNext() : null;

    // Durasi periode: kode promo gratis memakai durationDays dari admin,
    // selain itu memakai durasi paket (30/365 hari).
    const durationDays = promoGrant ? promoGrant.durationDays : planInfo.durationDays;
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setDate(periodEnd.getDate() + durationDays);

    const subscription = await this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const existingPending = await tx.subscription.findFirst({
          where: { userId, status: SubscriptionStatus.PENDING },
          select: { id: true },
        });
        if (existingPending) {
          throw new ConflictException({
            code: ErrorCodes.SUBSCRIPTION_ALREADY_ACTIVE,
            message: 'A subscription payment is already pending',
          });
        }

        const existingActive = await tx.subscription.findFirst({
          where: {
            userId,
            status: {
              in: [
                SubscriptionStatus.ACTIVE,
                SubscriptionStatus.CANCELLED,
                SubscriptionStatus.SUSPENDED,
                SubscriptionStatus.PAUSED,
              ],
            },
            currentPeriodEnd: { gt: new Date() },
          },
        });
        if (existingActive) {
          throw new ConflictException({
            code: ErrorCodes.SUBSCRIPTION_ALREADY_ACTIVE,
            message: 'You already have an active subscription period — use renew instead',
          });
        }

        let walletId: string | null = null;
        let balanceBefore = BigInt(0);
        let balanceAfter = BigInt(0);
        if (effectivePrice > BigInt(0)) {
          const walletRows = await tx.$queryRaw<
            Array<{
              id: string;
              userId: string;
              totalBalance: bigint;
              availableBalance: bigint;
              version: number;
            }>
          >`
          SELECT id, "userId", "totalBalance", "availableBalance", version FROM wallets WHERE "userId" = ${userId} FOR UPDATE`;
          const wallet = walletRows[0];
          if (!wallet) {
            throw new BadRequestException({
              code: ErrorCodes.INSUFFICIENT_BALANCE,
              message: 'Wallet not found',
            });
          }

          if (wallet.availableBalance < effectivePrice) {
            throw new BadRequestException({
              code: ErrorCodes.INSUFFICIENT_BALANCE,
              message: 'Insufficient wallet balance for subscription',
            });
          }

          const updated = await tx.wallet.updateMany({
            where: {
              id: wallet.id,
              version: wallet.version,
              availableBalance: { gte: effectivePrice },
            },
            data: {
              availableBalance: { decrement: effectivePrice },
              totalBalance: { decrement: effectivePrice },
              version: { increment: 1 },
            },
          });

          if (updated.count === 0) {
            throw new BadRequestException({
              code: ErrorCodes.INSUFFICIENT_BALANCE,
              message: 'Concurrent wallet update — please retry',
            });
          }

          walletId = wallet.id;
          balanceBefore = wallet.totalBalance;
          balanceAfter = wallet.totalBalance - effectivePrice;
        }

        if (campaignDiscount.campaign) {
          const campaignUpdated = await tx.campaign.updateMany({
            where: {
              id: campaignDiscount.campaign.id,
              status: CampaignStatus.ACTIVE,
              OR: [
                { maxRedemptions: null },
                { currentRedemptions: { lt: campaignDiscount.campaign.maxRedemptions as number } },
              ],
            },
            data: { currentRedemptions: { increment: 1 } },
          });
          if (campaignUpdated.count === 0) {
            throw new BadRequestException({ code: ErrorCodes.VOUCHER_USAGE_LIMIT_REACHED, message: 'Promo code has reached its maximum redemptions' });
          }
        }

        // Kode promo gratis: catat pemakaian secara atomik (race-safe).
        if (promoGrant) {
          const promoUpdated = await tx.subscriptionPromoCode.updateMany({
            where: {
              id: promoGrant.id,
              status: 'ACTIVE',
              OR: [
                { maxRedemptions: null },
                { currentRedemptions: { lt: promoGrant.maxRedemptions as number } },
              ],
            },
            data: { currentRedemptions: { increment: 1 } },
          });
          if (promoUpdated.count === 0) {
            throw new BadRequestException({ code: ErrorCodes.VOUCHER_USAGE_LIMIT_REACHED, message: 'Promo code has reached its maximum redemptions' });
          }
        }

        if (walletId && walletTxSerial !== null) {
          const walletTxId = generateWalletTxId(walletTxSerial);
          await tx.walletTransaction.create({
            data: {
              txId: walletTxId,
              walletId,
              type: WalletTransactionType.SUBSCRIPTION_PAYMENT,
              status: WalletTransactionStatus.SUCCESS,
              amount: effectivePrice,
              balanceBefore,
              balanceAfter,
              description: `${planInfo.label} subscription payment${campaignDiscount.discountSen > BigInt(0) ? ` (discount Rp ${toIdr(campaignDiscount.discountSen).toLocaleString('id-ID')})` : ''}`,
            },
          });
        }

        const feeSavingsLimitIdr = this.configService.get<number>('app.feeSavingsLimit') ?? 5000000;
        const feeSavingsLimitSen = toSen(feeSavingsLimitIdr);

        const sub = await tx.subscription.create({
          data: {
            userId,
            plan,
            status: SubscriptionStatus.ACTIVE,
            price: effectivePrice,
            originalPrice: campaignDiscount.discountSen > BigInt(0) || promoGrant ? planInfo.price : null,
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
            isAutoRenew: false,
            lastPaymentAt: effectivePrice > BigInt(0) ? now : null,
            nextPaymentAt: periodEnd,
            feeSavingsLimit: feeSavingsLimitSen,
            // Kode promo gratis admin yang dipakai untuk langganan ini (audit).
            promoCodeUsed: promoGrant ? promoGrant.code : undefined,
          },
        });

        // kahadePlusSince hanya diisi saat PERTAMA kali subscribe dan tidak pernah
        // di-reset — dipakai badge "Kahade+" dan bagian "Tentang" di profil publik.
        await tx.user.update({
          where: { id: userId },
          data: {
            isKahadePlus: true,
            subscriptionExpiresAt: periodEnd,
            ...(await this.buildKahadePlusSinceData(tx, userId, now)),
          },
        });

        return sub;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    // AUDIT-24: orders.service caches `subscription_status:<userId>` for 300 s to decide
    // fee discounts at order creation; without invalidation here (and in cancel/renew and
    // the expiry cron) a just-purchased or just-expired Plus state kept applying stale
    // rates inside that window.
    await this.redis.del(`subscription_status:${userId}`).catch((err: unknown) =>
      this.logger.warn(`Failed to invalidate subscription status cache for ${userId}: ${err instanceof Error ? err.message : String(err)}`),
    );

    // Section 1: badge "Kahade+" juga read-through cache — invalidasi post-commit
    // supaya badge langsung muncul tanpa menunggu TTL.
    await this.verificationBadgeService.invalidate(userId);

    this.logger.log(`User ${userId} subscribed to ${plan}, charged ${effectivePrice} sen`);

    this.auditLogService.logUserAction({
      userId,
      action: UserAuditAction.SUBSCRIPTION_STARTED,
      entityType: 'Subscription',
      entityId: subscription.id,
      description: `Subscribed to ${plan} plan${promoGrant ? ` (promo ${promoGrant.code})` : ''}`,
    });

    return subscription;
  }

  /**
   * Berlangganan Kahade+ via QRIS (Flash Mobile/MNC).
   *
   * Keputusan produk 2026-09-26: pembayaran = Wallet/QRIS + PIN. Midtrans
   * TIDAK dipakai lagi; QRIS diproses via Flash Mobile.
   *
   * Alur:
   * 1. Verifikasi PIN wallet (wajib — sesuai "Wallet/QRIS + PIN").
   * 2. Buat subscription status PENDING + PaymentTransaction.
   * 3. Buat QRIS dinamis di Flash → kembalikan qrString untuk dirender di app.
   * 4. User scan & bayar → webhook Flash → activateQrisSubscription().
   * 5. Frontend polling GET /v1/subscriptions/qris-status/:id sebagai fallback.
   */
  /**
   * CW-003: subscription PENDING yang QR-nya sudah kedaluwarsa (atau gagal
   * dibuat >1 jam lalu, mis. Flash down setelah row PENDING dibuat) tidak
   * boleh memblokir subscribe ulang selamanya. Tandai EXPIRED dengan guard
   * status PENDING (idempoten, aman di-retry) + paymentTx → FAILED.
   * Tidak menggerakkan uang: pembayaran PENDING tidak pernah sukses.
   */
  private async expireStalePendingSubscriptions(userId: string): Promise<void> {
    const now = new Date();
    const staleCutoff = new Date(now.getTime() - 60 * 60 * 1000);
    const stale = await this.prisma.subscription.findMany({
      where: {
        userId,
        status: SubscriptionStatus.PENDING,
        OR: [
          { paymentTx: { expiredAt: { lt: now } } },
          {
            paymentTx: {
              expiredAt: null,
              flashTransactionId: null,
              createdAt: { lt: staleCutoff },
            },
          },
        ],
      },
      select: { id: true, paymentTxId: true },
    });
    for (const s of stale) {
      await this.prisma.$transaction(async (tx) => {
        await tx.subscription.updateMany({
          where: { id: s.id, status: SubscriptionStatus.PENDING },
          data: { status: SubscriptionStatus.EXPIRED },
        });
        if (s.paymentTxId) {
          await tx.paymentTransaction.updateMany({
            where: { id: s.paymentTxId, status: PaymentStatus.PENDING },
            data: { status: PaymentStatus.FAILED, failedAt: now },
          });
        }
      });
      this.logger.log(`Subscription PENDING basi ${s.id} di-expire agar user ${userId} bisa subscribe ulang`);
    }
  }

  /**
   * SP-003: gagalkan subscription QRIS yang masih PENDING (guard status) +
   * paymentTx-nya → FAILED, agar user bisa langsung subscribe ulang tanpa
   * menunggu cleanup PENDING basi (1 jam). Tidak menggerakkan uang:
   * pembayaran PENDING tidak pernah sukses.
   */
  private async failPendingQrisSubscription(subscriptionId: string, paymentTxId: string): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.subscription.updateMany({
        where: { id: subscriptionId, status: SubscriptionStatus.PENDING },
        data: { status: SubscriptionStatus.EXPIRED },
      });
      await tx.paymentTransaction.updateMany({
        where: { id: paymentTxId, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.FAILED, failedAt: now },
      });
    });
  }

  async subscribeQris(
    userId: string,
    plan: SubscriptionPlan,
    pin: string,
    ip?: string,
    promoCode?: string,
  ): Promise<{ subscription: Subscription; qrString: string; expiredAt: Date; flashTransactionId: string }> {
    const planInfo = this.planPricing[plan];
    if (!planInfo) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Invalid subscription plan',
      });
    }
    // SP-032: validasi format PIN dipindah ke SETELAH cabang promo gratis —
    // path gratis tidak boleh memaksa PIN (DTO: pin opsional; subscribe()
    // sendiri hanya memverifikasi PIN bila effectivePrice > 0).
    // CW-003: expire PENDING basi dulu agar tidak memblokir subscribe ulang.
    await this.expireStalePendingSubscriptions(userId);

    const promoGrant = await this.resolvePromoCodeGrant(userId, promoCode);
    if (promoGrant) {
      // Kode gratis → tidak perlu QRIS; pakai jalur subscribe biasa (gratis).
      const subscription = await this.subscribe(userId, plan, undefined, ip, { promoCode });
      return { subscription, qrString: '', expiredAt: new Date(), flashTransactionId: '' };
    }

    const campaignDiscount = await this.resolveSubscriptionCampaign(userId, promoCode, planInfo.price);
    const effectivePrice = planInfo.price - campaignDiscount.discountSen;
    if (effectivePrice <= BigInt(0)) {
      // Didiskon 100% → gratis, tidak perlu QRIS.
      const subscription = await this.subscribe(userId, plan, undefined, ip, { promoCode });
      return { subscription, qrString: '', expiredAt: new Date(), flashTransactionId: '' };
    }

    // Misi tanpa-wallet (BI-safe): jalur Flash+wallet mati — QRIS diproses
    // via DANA direct. PIN adalah konsep wallet dan tidak dibutuhkan DANA.
    if (!this.walletMode.isWalletEnabled()) {
      const dana = await this.subscribeDana(userId, plan, DanaDirectPayKind.QRIS, undefined, promoCode, ip);
      return {
        subscription: dana.subscription,
        qrString: dana.qrString ?? '',
        expiredAt: dana.expiredAt,
        flashTransactionId: '',
      };
    }
    // Di titik ini pembayaran QRIS pasti terjadi → PIN wajib & valid.
    if (!pin || !/^\d{6}$/.test(pin)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Wallet PIN is required for QRIS subscription payment',
      });
    }
    await this.walletService.verifyPin(userId, pin, ip);

    const durationDays = planInfo.durationDays;
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setDate(periodEnd.getDate() + durationDays);
    const amountIdr = toIdr(effectivePrice);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { fullName: true, email: true, phoneNumber: true },
    });

    // Buat subscription PENDING + payment transaction dulu (external_id stabil).
    const pending = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const existingPending = await tx.subscription.findFirst({
        where: { userId, status: SubscriptionStatus.PENDING },
        select: { id: true },
      });
      if (existingPending) {
        throw new ConflictException({
          code: ErrorCodes.SUBSCRIPTION_ALREADY_ACTIVE,
          message: 'A subscription payment is already pending',
        });
      }
      const existingActive = await tx.subscription.findFirst({
        where: {
          userId,
          status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.CANCELLED, SubscriptionStatus.SUSPENDED, SubscriptionStatus.PAUSED] },
          currentPeriodEnd: { gt: new Date() },
        },
        select: { id: true },
      });
      if (existingActive) {
        throw new ConflictException({
          code: ErrorCodes.SUBSCRIPTION_ALREADY_ACTIVE,
          message: 'You already have an active subscription period — use renew instead',
        });
      }

      const paymentTx = await tx.paymentTransaction.create({
        data: {
          midtransOrderId: `SUBS-QRIS-${Date.now()}-${userId.slice(-6)}`,
          userId,
          provider: PaymentProvider.FLASH,
          purpose: PaymentPurpose.SUBSCRIPTION,
          method: PaymentMethod.QRIS,
          status: PaymentStatus.PENDING,
          amount: effectivePrice,
          grossAmount: effectivePrice,
        },
      });

      const sub = await tx.subscription.create({
        data: {
          userId,
          plan,
          status: SubscriptionStatus.PENDING,
          price: effectivePrice,
          originalPrice: campaignDiscount.discountSen > BigInt(0) ? planInfo.price : null,
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          isAutoRenew: false,
          paymentMethod: PaymentMethod.QRIS,
          paymentTxId: paymentTx.id,
          promoCodeUsed: promoCode?.trim().toUpperCase() || undefined,
        },
      });

      return { sub, paymentTx };
    });

    // Buat QRIS di Flash (di luar transaksi DB).
    // CW-004: Flash membatasi external_id 16 karakter. Potongan
    // "SUBS-QRIS-<epoch>" sebelumnya bertabrakan untuk semua pembayaran
    // dalam jendela ~2,78 jam. Pakai 16 karakter pertama paymentTx.id (cuid)
    // — unik per pembayaran dan deterministik dari baris DB sehingga callback
    // bisa dicocokkan ulang (CW-005).
    const externalId = pending.paymentTx.id.slice(0, 16);
    // SP-003: bila Flash gagal SETELAH baris PENDING dibuat (timeout/down),
    // gagalkan baris PENDING-nya sekalian agar tidak mengunci subscribe ulang
    // sampai cleanup basi (1 jam). Guard PENDING membuat retry aman.
    let qris: FlashQrisPayment;
    try {
      qris = await this.flashQrisService.createQrisPayment({
        externalId,
        amountIdr,
        description: `${planInfo.label} — Kahade+`,
        fullname: user?.fullName ?? '',
        email: user?.email ?? '',
        phoneNumber: user?.phoneNumber ?? '',
      });
    } catch (err) {
      await this.failPendingQrisSubscription(pending.sub.id, pending.paymentTx.id);
      throw err;
    }

    await this.prisma.paymentTransaction.update({
      where: { id: pending.paymentTx.id },
      data: {
        flashTransactionId: qris.transactionId,
        flashQrString: qris.qrString,
        expiredAt: qris.expiredAt,
      },
    });

    this.auditLogService.logUserAction({
      userId,
      action: UserAuditAction.SUBSCRIPTION_STARTED,
      entityType: 'Subscription',
      entityId: pending.sub.id,
      description: `QRIS payment initiated for ${plan} plan (${amountIdr} IDR)`,
    });

    return {
      subscription: pending.sub,
      qrString: qris.qrString,
      expiredAt: qris.expiredAt,
      flashTransactionId: qris.transactionId,
    };
  }

  /**
   * Berlangganan Kahade+ via DANA langsung (mode tanpa-wallet, BI-safe).
   *
   * Keputusan 2026-09-29: subscription dibayar via DANA direct (QRIS / VA /
   * BALANCE — tidak hardcode QRIS). Subscription tetap PENDING sampai webhook
   * DANA finish-notify sukses (fail-closed: gagal bayar = tidak aktif).
   * Kode promo gratis / diskon 100% tetap lewat jalur subscribe() gratis.
   */
  async subscribeDana(
    userId: string,
    plan: SubscriptionPlan,
    payKind: DanaDirectPayKind,
    bankCode?: string,
    promoCode?: string,
    ip?: string,
  ): Promise<{
    subscription: Subscription;
    qrString: string | null;
    paymentCode: string | null;
    webRedirectUrl: string | null;
    expiredAt: Date;
  }> {
    const planInfo = this.planPricing[plan];
    if (!planInfo) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Invalid subscription plan',
      });
    }
    if (!Object.values(DanaDirectPayKind).includes(payKind)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Invalid payKind — gunakan daftar dari GET /v1/orders/:id/payment-methods',
      });
    }
    const vaBank = payKind === DanaDirectPayKind.VA ? assertVaBank(bankCode) : undefined;
    void ip;

    // CW-003: expire PENDING basi dulu agar tidak memblokir subscribe ulang.
    await this.expireStalePendingSubscriptions(userId);

    const promoGrant = await this.resolvePromoCodeGrant(userId, promoCode);
    if (promoGrant) {
      const subscription = await this.subscribe(userId, plan, undefined, undefined, { promoCode });
      return { subscription, qrString: null, paymentCode: null, webRedirectUrl: null, expiredAt: new Date() };
    }

    const campaignDiscount = await this.resolveSubscriptionCampaign(userId, promoCode, planInfo.price);
    const effectivePrice = planInfo.price - campaignDiscount.discountSen;
    if (effectivePrice <= BigInt(0)) {
      const subscription = await this.subscribe(userId, plan, undefined, undefined, { promoCode });
      return { subscription, qrString: null, paymentCode: null, webRedirectUrl: null, expiredAt: new Date() };
    }

    const durationDays = planInfo.durationDays;
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setDate(periodEnd.getDate() + durationDays);
    const amountIdr = toIdr(effectivePrice);
    if (amountIdr <= 0) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid subscription amount' });
    }

    const partnerReferenceNo = generateDanaPartnerReferenceNo();
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { fullName: true, email: true, phoneNumber: true },
    });

    // Buat subscription PENDING + payment transaction DANA dulu.
    const pending = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const existingPending = await tx.subscription.findFirst({
        where: { userId, status: SubscriptionStatus.PENDING },
        select: { id: true },
      });
      if (existingPending) {
        throw new ConflictException({
          code: ErrorCodes.SUBSCRIPTION_ALREADY_ACTIVE,
          message: 'A subscription payment is already pending',
        });
      }
      const existingActive = await tx.subscription.findFirst({
        where: {
          userId,
          status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.CANCELLED, SubscriptionStatus.SUSPENDED, SubscriptionStatus.PAUSED] },
          currentPeriodEnd: { gt: new Date() },
        },
        select: { id: true },
      });
      if (existingActive) {
        throw new ConflictException({
          code: ErrorCodes.SUBSCRIPTION_ALREADY_ACTIVE,
          message: 'You already have an active subscription period — use renew instead',
        });
      }

      const paymentTx = await tx.paymentTransaction.create({
        data: {
          midtransOrderId: `SUBS-DANA-${Date.now()}-${userId.slice(-6)}`,
          userId,
          provider: PaymentProvider.DANA,
          purpose: PaymentPurpose.SUBSCRIPTION,
          method: payKind === DanaDirectPayKind.VA ? PaymentMethod.VIRTUAL_ACCOUNT_OTHER : payKind === DanaDirectPayKind.BALANCE ? PaymentMethod.DANA : PaymentMethod.QRIS,
          status: PaymentStatus.PENDING,
          amount: effectivePrice,
          grossAmount: effectivePrice,
          danaPartnerReferenceNo: partnerReferenceNo,
          danaPayKind: payKind,
        },
      });

      const sub = await tx.subscription.create({
        data: {
          userId,
          plan,
          status: SubscriptionStatus.PENDING,
          price: effectivePrice,
          originalPrice: campaignDiscount.discountSen > BigInt(0) ? planInfo.price : null,
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          isAutoRenew: false,
          paymentMethod: payKind === DanaDirectPayKind.VA ? PaymentMethod.VIRTUAL_ACCOUNT_OTHER : payKind === DanaDirectPayKind.BALANCE ? PaymentMethod.DANA : PaymentMethod.QRIS,
          paymentTxId: paymentTx.id,
          promoCodeUsed: promoCode?.trim().toUpperCase() || undefined,
        },
      });

      return { sub, paymentTx };
    });

    // Buat order di DANA (di luar transaksi DB). Gagal → expire PENDING
    // (fail-closed: tidak mengunci subscribe ulang, guard PENDING).
    let created;
    try {
      created = await this.danaPaymentService.createOrder({
        kind: payKind,
        partnerReferenceNo,
        amountIdr,
        orderTitle: `${planInfo.label} — Kahade+`,
        bankCode: vaBank,
        buyerExternalUserId: userId,
      });
    } catch (err) {
      await this.failPendingQrisSubscription(pending.sub.id, pending.paymentTx.id);
      throw err;
    }

    await this.prisma.paymentTransaction.update({
      where: { id: pending.paymentTx.id },
      data: {
        danaReferenceNo: created.referenceNo,
        providerInstructions: {
          kind: payKind,
          qrString: payKind === DanaDirectPayKind.QRIS ? created.paymentCode : undefined,
          paymentCode: payKind === DanaDirectPayKind.VA ? created.paymentCode : undefined,
          webRedirectUrl: created.webRedirectUrl,
        } as Prisma.InputJsonValue,
        expiredAt: created.expiresAt,
      },
    });

    this.auditLogService.logUserAction({
      userId,
      action: UserAuditAction.SUBSCRIPTION_STARTED,
      entityType: 'Subscription',
      entityId: pending.sub.id,
      description: `DANA ${payKind} payment initiated for ${plan} plan (${amountIdr} IDR)`,
    });

    return {
      subscription: pending.sub,
      qrString: payKind === DanaDirectPayKind.QRIS ? created.paymentCode : null,
      paymentCode: payKind === DanaDirectPayKind.VA ? created.paymentCode : null,
      webRedirectUrl: created.webRedirectUrl ?? null,
      expiredAt: created.expiresAt,
    };
  }

  /**
   * Dipanggil webhook DANA saat pembayaran subscription sukses — aktivasi.
   * Menangani DUA kasus:
   *  - subscribe baru: paymentTx.subscriptions[0] berstatus PENDING → ACTIVE.
   *  - renewal: paymentTx.renewalForSubscriptionId terisi → perpanjang
   *    currentPeriodEnd subscription yang ada.
   * Idempotent: klaim atomik PENDING→SUCCESS + guard status subscription.
   * Fail-closed: verify-via-API + cek nominal sebelum aktivasi.
   */
  async activateDanaSubscription(paymentTxId: string): Promise<void> {
    const paymentTx = await this.prisma.paymentTransaction.findUnique({
      where: { id: paymentTxId },
      include: { subscriptions: true },
    });
    if (!paymentTx || paymentTx.provider !== PaymentProvider.DANA || paymentTx.purpose !== PaymentPurpose.SUBSCRIPTION) {
      this.logger.warn(`Webhook DANA subscription: payment tx tidak eligible (${paymentTxId})`);
      return;
    }
    if (paymentTx.status === PaymentStatus.SUCCESS) return; // sudah diproses

    const detail = await this.danaPaymentService.getPaymentDetail(
      paymentTx.danaPartnerReferenceNo ?? paymentTxId,
    );
    if (detail.status !== 'SUCCESS') {
      this.logger.warn(`Webhook DANA subscription: status DANA bukan SUCCESS (${detail.status}) untuk ${paymentTx.id}`);
      return;
    }
    const expectedIdr = Math.round(Number(paymentTx.grossAmount) / 100);
    if (detail.amountIdr === null || detail.amountIdr !== expectedIdr) {
      this.logger.error(
        `DANA_AMOUNT_MISMATCH: subscription ${paymentTx.id} dibayar ${detail.amountIdr} IDR, ` +
        `diharapkan ${expectedIdr} IDR — aktivasi DITOLAK`,
      );
      return;
    }

    const now = new Date();
    const planInfo = (plan: SubscriptionPlan) => this.planPricing[plan];

    try {
      await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const claimedPayment = await tx.paymentTransaction.updateMany({
          where: { id: paymentTx.id, status: PaymentStatus.PENDING },
          data: { status: PaymentStatus.SUCCESS, paidAt: now, webhookReceivedAt: now },
        });
        if (claimedPayment.count !== 1) {
          throw new SubscriptionActivationRaceError(paymentTx.id);
        }

        if (paymentTx.renewalForSubscriptionId) {
          // RENEWAL: perpanjang periode subscription yang ada.
          const sub = await tx.subscription.findUnique({ where: { id: paymentTx.renewalForSubscriptionId } });
          if (!sub) throw new SubscriptionActivationRaceError(paymentTx.id);
          const info = planInfo(sub.plan);
          const renewBase = sub.status === SubscriptionStatus.SUSPENDED ? now : new Date(sub.currentPeriodEnd ?? now);
          const newPeriodEnd = new Date(renewBase);
          newPeriodEnd.setDate(newPeriodEnd.getDate() + info.durationDays);
          await tx.subscription.update({
            where: { id: sub.id },
            data: {
              status: SubscriptionStatus.ACTIVE,
              currentPeriodEnd: newPeriodEnd,
              lastPaymentAt: now,
              nextPaymentAt: newPeriodEnd,
              cancelAtPeriodEnd: false,
              isAutoRenew: false,
            },
          });
          await tx.user.update({
            where: { id: sub.userId },
            data: { isKahadePlus: true, subscriptionExpiresAt: newPeriodEnd },
          });
          this.logger.log(`Subscription ${sub.id} renewed via DANA direct sampai ${newPeriodEnd.toISOString()}`);
        } else {
          // SUBSCRIBE BARU: aktivasi subscription PENDING.
          const subscription = paymentTx.subscriptions[0];
          if (!subscription || subscription.status !== SubscriptionStatus.PENDING) {
            this.logger.warn(`Webhook DANA subscription: subscription tidak PENDING untuk ${paymentTx.id}`);
            throw new SubscriptionActivationRaceError(paymentTx.id);
          }
          const claimedSub = await tx.subscription.updateMany({
            where: { id: subscription.id, status: SubscriptionStatus.PENDING },
            data: {
              status: SubscriptionStatus.ACTIVE,
              lastPaymentAt: now,
              nextPaymentAt: subscription.currentPeriodEnd,
            },
          });
          if (claimedSub.count !== 1) {
            throw new SubscriptionActivationRaceError(paymentTx.id);
          }
          await tx.user.update({
            where: { id: subscription.userId },
            data: {
              isKahadePlus: true,
              subscriptionExpiresAt: subscription.currentPeriodEnd,
              ...(await this.buildKahadePlusSinceData(tx, subscription.userId, now)),
            },
          });
          this.logger.log(`Subscription ${subscription.id} activated via DANA direct`);
        }
      });
    } catch (err) {
      if (err instanceof SubscriptionActivationRaceError) {
        this.logger.warn(`Webhook DANA subscription: aktivasi ${paymentTx.id} tidak diklaim (sudah diproses konkuren)`);
        return;
      }
      throw err;
    }

    const targetUserId = paymentTx.renewalForSubscriptionId
      ? (await this.prisma.subscription.findUnique({ where: { id: paymentTx.renewalForSubscriptionId }, select: { userId: true } }))?.userId
      : paymentTx.subscriptions[0]?.userId;
    if (targetUserId) {
      await this.redis.del(`subscription_status:${targetUserId}`).catch(() => undefined);
      await this.verificationBadgeService.invalidate(targetUserId);
      this.auditLogService.logUserAction({
        userId: targetUserId,
        action: UserAuditAction.SUBSCRIPTION_STARTED,
        entityType: 'Subscription',
        entityId: paymentTx.renewalForSubscriptionId ?? paymentTx.subscriptions[0]?.id ?? paymentTx.id,
        description: `DANA payment confirmed — subscription ${paymentTx.renewalForSubscriptionId ? 'renewed' : 'activated'}`,
      });
    }
  }

  /**
   * Renew Kahade+ via DANA langsung (mode tanpa-wallet).
   * Membuat payment DANA untuk perpanjangan; periode diperpanjang oleh
   * webhook via activateDanaSubscription (fail-closed sampai bayar sukses).
   */
  async renewDana(
    userId: string,
    payKind: DanaDirectPayKind,
    bankCode?: string,
  ): Promise<{
    paymentTxId: string;
    qrString: string | null;
    paymentCode: string | null;
    webRedirectUrl: string | null;
    expiredAt: Date;
  }> {
    if (!Object.values(DanaDirectPayKind).includes(payKind)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid payKind' });
    }
    const vaBank = payKind === DanaDirectPayKind.VA ? assertVaBank(bankCode) : undefined;

    const subscription = await this.prisma.subscription.findFirst({
      where: {
        userId,
        status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.CANCELLED, SubscriptionStatus.SUSPENDED] },
        currentPeriodEnd: { gt: new Date() },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (!subscription) {
      throw new NotFoundException({ code: ErrorCodes.NO_ACTIVE_SUBSCRIPTION, message: 'No active subscription found' });
    }
    if (subscription.status === SubscriptionStatus.CANCELLED && subscription.cancelReason === 'Force cancelled by admin') {
      throw new ConflictException({ code: ErrorCodes.INVALID_STATUS, message: 'This subscription was cancelled by an administrator' });
    }

    const planInfo = this.planPricing[subscription.plan];
    const amountIdr = toIdr(planInfo.price);
    const partnerReferenceNo = generateDanaPartnerReferenceNo();

    const paymentTx = await this.prisma.paymentTransaction.create({
      data: {
        midtransOrderId: `SUBS-DANA-RNW-${Date.now()}-${userId.slice(-6)}`,
        userId,
        provider: PaymentProvider.DANA,
        purpose: PaymentPurpose.SUBSCRIPTION,
        method: payKind === DanaDirectPayKind.VA ? PaymentMethod.VIRTUAL_ACCOUNT_OTHER : payKind === DanaDirectPayKind.BALANCE ? PaymentMethod.DANA : PaymentMethod.QRIS,
        status: PaymentStatus.PENDING,
        amount: planInfo.price,
        grossAmount: planInfo.price,
        danaPartnerReferenceNo: partnerReferenceNo,
        danaPayKind: payKind,
        renewalForSubscriptionId: subscription.id,
      },
    });

    let created;
    try {
      created = await this.danaPaymentService.createOrder({
        kind: payKind,
        partnerReferenceNo,
        amountIdr,
        orderTitle: `${planInfo.label} renewal — Kahade+`,
        bankCode: vaBank,
        buyerExternalUserId: userId,
      });
    } catch (err) {
      await this.prisma.paymentTransaction.updateMany({
        where: { id: paymentTx.id, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.FAILED, failedAt: new Date() },
      });
      throw err;
    }

    await this.prisma.paymentTransaction.update({
      where: { id: paymentTx.id },
      data: {
        danaReferenceNo: created.referenceNo,
        providerInstructions: {
          kind: payKind,
          qrString: payKind === DanaDirectPayKind.QRIS ? created.paymentCode : undefined,
          paymentCode: payKind === DanaDirectPayKind.VA ? created.paymentCode : undefined,
          webRedirectUrl: created.webRedirectUrl,
        } as Prisma.InputJsonValue,
        expiredAt: created.expiresAt,
      },
    });

    return {
      paymentTxId: paymentTx.id,
      qrString: payKind === DanaDirectPayKind.QRIS ? created.paymentCode : null,
      paymentCode: payKind === DanaDirectPayKind.VA ? created.paymentCode : null,
      webRedirectUrl: created.webRedirectUrl ?? null,
      expiredAt: created.expiresAt,
    };
  }

  /**
   * Status pembayaran DANA subscription untuk polling frontend.
   * Sinkronisasi ringan: tanya DANA bila masih PENDING dan belum kedaluwarsa.
   */
  async getDanaStatus(userId: string, subscriptionId: string): Promise<{
    status: string;
    qrString: string | null;
    paymentCode: string | null;
    webRedirectUrl: string | null;
    expiredAt: Date | null;
  }> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { id: subscriptionId, userId },
      include: { paymentTx: true },
    });
    if (!subscription) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Subscription not found' });
    }
    const pt = subscription.paymentTx;
    const instructions = (pt?.providerInstructions ?? {}) as Record<string, unknown>;
    if (
      subscription.status === SubscriptionStatus.PENDING &&
      pt?.provider === PaymentProvider.DANA &&
      pt.danaPartnerReferenceNo &&
      (!pt.expiredAt || pt.expiredAt > new Date())
    ) {
      const detail = await this.danaPaymentService.getPaymentDetail(pt.danaPartnerReferenceNo);
      if (detail.status === 'SUCCESS') {
        await this.activateDanaSubscription(pt.id);
      } else if (detail.status === 'FAILED') {
        await this.failPendingQrisSubscription(subscription.id, pt.id);
      }
      const refreshed = await this.prisma.subscription.findUnique({ where: { id: subscription.id } });
      const refreshedPt = await this.prisma.paymentTransaction.findUnique({ where: { id: pt.id } });
      const ri = (refreshedPt?.providerInstructions ?? {}) as Record<string, unknown>;
      return {
        status: refreshed?.status ?? subscription.status,
        qrString: (ri.qrString as string | undefined) ?? null,
        paymentCode: (ri.paymentCode as string | undefined) ?? null,
        webRedirectUrl: (ri.webRedirectUrl as string | undefined) ?? null,
        expiredAt: refreshedPt?.expiredAt ?? null,
      };
    }
    return {
      status: subscription.status,
      qrString: (instructions.qrString as string | undefined) ?? null,
      paymentCode: (instructions.paymentCode as string | undefined) ?? null,
      webRedirectUrl: (instructions.webRedirectUrl as string | undefined) ?? null,
      expiredAt: pt?.expiredAt ?? null,
    };
  }

  /**
   * Refund pembayaran subscription DANA ke metode bayar asal (dipakai admin
   * force-cancel). Idempoten via idempotencyKey stabil.
   */
  async refundDanaSubscriptionPayment(subscriptionId: string, reason: string): Promise<boolean> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      select: { id: true, paymentTxId: true, userId: true },
    });
    if (!subscription?.paymentTxId) return false;
    const res = await this.danaDirectRefundService.refundAmount({
      paymentDbId: subscription.paymentTxId,
      reason,
      idempotencyKey: `ADMIN_SUB_CANCEL:${subscriptionId}`,
    });
    return res.refunded;
  }

  /**
   * Dipanggil webhook Flash saat pembayaran QRIS sukses — aktivasi subscription.
   * Idempotent: hanya memproses sekali (klaim atomik di dalam transaksi).
   *
   * WF-007: nominal terbayar dari API Flash dibandingkan dengan nominal yang
   * ditagih (fail-closed saat mismatch). WF-023: guard status dipindah ke
   * dalam transaksi via updateMany ber-guard WHERE agar dua webhook konkuren
   * tidak menduplikasi aktivasi/audit-log.
   */
  async activateQrisSubscription(flashTransactionId: string, externalId: string): Promise<void> {
    // CW-005: cabang fallback via external_id yang lama
    // ({ midtransOrderId: externalId }) tidak pernah cocok karena externalId
    // adalah potongan 16 char sementara midtransOrderId full-length.
    // Sekarang externalId = 16 char pertama paymentTx.id → fallback hidup via
    // pencocokan prefix id. Guard string kosong: startsWith('') cocok semua.
    const orConditions: Prisma.PaymentTransactionWhereInput[] = [{ flashTransactionId }];
    if (externalId) {
      orConditions.push({ id: { startsWith: externalId } });
    }
    const paymentTx = await this.prisma.paymentTransaction.findFirst({
      where: {
        OR: orConditions,
        provider: PaymentProvider.FLASH,
        purpose: PaymentPurpose.SUBSCRIPTION,
      },
      include: { subscriptions: true },
    });
    if (!paymentTx) {
      this.logger.warn(`Webhook QRIS Flash: payment tx tidak ditemukan (${flashTransactionId}/${externalId})`);
      return;
    }
    if (paymentTx.status === PaymentStatus.SUCCESS) return; // sudah diproses

    // Verifikasi ke Flash sebelum aktivasi (docs tidak punya signature webhook).
    // WF-007: pakai detail (status + amount), bukan status saja.
    const flashDetail = await this.flashQrisService.getPaymentDetail(
      paymentTx.flashTransactionId ?? flashTransactionId,
    );
    if (flashDetail.status !== 'SUCCESS') {
      this.logger.warn(`Webhook QRIS Flash: status Flash bukan SUCCESS (${flashDetail.status}) untuk ${paymentTx.id}`);
      return;
    }

    // WF-007: nominal yang dibayar harus sama dengan yang ditagih.
    // Bandingkan dalam rupiah bulat (fail-closed bila mismatch).
    const expectedIdr = Math.round(toIdr(paymentTx.grossAmount));
    if (flashDetail.amountIdr !== null && Math.round(flashDetail.amountIdr) !== expectedIdr) {
      this.logger.error(
        `FLASH_AMOUNT_MISMATCH: subscription ${paymentTx.id} dibayar ${flashDetail.amountIdr} IDR, ` +
        `diharapkan ${expectedIdr} IDR — aktivasi DITOLAK`,
      );
      return;
    }
    if (flashDetail.amountIdr === null) {
      // Shape amount respons Flash tak terdokumentasi penuh: jangan matikan
      // alur, tapi catat agar termonitor. Jangkar kepercayaan utama tetap
      // status SUCCESS yang diverifikasi via API Flash.
      this.logger.warn(
        `Webhook QRIS Flash: amount tidak tersedia di respons Flash untuk ${paymentTx.id} — ` +
        `aktivasi dilanjut berdasarkan status SUCCESS terverifikasi`,
      );
    }

    const subscription = paymentTx.subscriptions[0];
    if (!subscription || subscription.status !== SubscriptionStatus.PENDING) {
      this.logger.warn(`Webhook QRIS Flash: subscription tidak PENDING untuk ${paymentTx.id}`);
      return;
    }

    const now = new Date();
    // WF-023: klaim atomik — guard status di WHERE dalam satu transaksi.
    // Pemenang klaim memproses penuh; yang kalah rollback total (tanpa
    // side-effect: tanpa audit log ganda, tanpa notifikasi ganda).
    try {
      await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const claimedPayment = await tx.paymentTransaction.updateMany({
          where: { id: paymentTx.id, status: PaymentStatus.PENDING },
          data: { status: PaymentStatus.SUCCESS, paidAt: now, webhookReceivedAt: now },
        });
        const claimedSub = await tx.subscription.updateMany({
          where: { id: subscription.id, status: SubscriptionStatus.PENDING },
          data: {
            status: SubscriptionStatus.ACTIVE,
            lastPaymentAt: now,
            nextPaymentAt: subscription.currentPeriodEnd,
          },
        });
        if (claimedPayment.count !== 1 || claimedSub.count !== 1) {
          // Diklaim pihak lain (webhook konkuren / polling) — rollback.
          throw new SubscriptionActivationRaceError(paymentTx.id);
        }
        await tx.user.update({
          where: { id: subscription.userId },
          data: {
            isKahadePlus: true,
            subscriptionExpiresAt: subscription.currentPeriodEnd,
            ...(await this.buildKahadePlusSinceData(tx, subscription.userId, now)),
          },
        });
      });
    } catch (err) {
      if (err instanceof SubscriptionActivationRaceError) {
        this.logger.warn(
          `Webhook QRIS Flash: aktivasi ${paymentTx.id} tidak diklaim (sudah diproses konkuren)`,
        );
        return;
      }
      throw err;
    }

    await this.redis.del(`subscription_status:${subscription.userId}`).catch(() => undefined);
    await this.verificationBadgeService.invalidate(subscription.userId);

    this.auditLogService.logUserAction({
      userId: subscription.userId,
      action: UserAuditAction.SUBSCRIPTION_STARTED,
      entityType: 'Subscription',
      entityId: subscription.id,
      description: `QRIS payment confirmed — ${subscription.plan} activated`,
    });
    this.logger.log(`Subscription ${subscription.id} activated via Flash QRIS`);
  }

  /**
   * Status pembayaran QRIS untuk polling frontend.
   */
  async getQrisStatus(userId: string, subscriptionId: string): Promise<{ status: string; qrString: string | null; expiredAt: Date | null }> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { id: subscriptionId, userId },
      include: { paymentTx: true },
    });
    if (!subscription) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Subscription not found' });
    }
    // Sinkronisasi ringan: tanya Flash bila masih PENDING dan belum kedaluwarsa.
    if (
      subscription.status === SubscriptionStatus.PENDING &&
      subscription.paymentTx?.flashTransactionId &&
      (!subscription.paymentTx.expiredAt || subscription.paymentTx.expiredAt > new Date())
    ) {
      const flashStatus = await this.flashQrisService.getPaymentStatus(subscription.paymentTx.flashTransactionId);
      if (flashStatus === 'SUCCESS') {
        await this.activateQrisSubscription(subscription.paymentTx.flashTransactionId, '');
      } else if (flashStatus === 'FAILED') {
        // SP-003: payment FAILED → subscription PENDING ikut EXPIRED agar
        // tidak mengunci user (guard PENDING di helper membuatnya idempoten).
        await this.failPendingQrisSubscription(subscription.id, subscription.paymentTx.id);
      }
      const refreshed = await this.prisma.subscription.findUnique({ where: { id: subscription.id } });
      return {
        status: refreshed?.status ?? subscription.status,
        qrString: subscription.paymentTx.flashQrString,
        expiredAt: subscription.paymentTx.expiredAt,
      };
    }
    return {
      status: subscription.status,
      qrString: subscription.paymentTx?.flashQrString ?? null,
      expiredAt: subscription.paymentTx?.expiredAt ?? null,
    };
  }

  /**
   * Cancel-at-period-end (keputusan produk 2026-09-26).
   *
   * User TETAP menikmati semua benefit sampai currentPeriodEnd; yang berubah:
   * - cancelAtPeriodEnd = true (flag)
   * - isAutoRenew = false (tidak diperpanjang otomatis)
   * - status TETAP ACTIVE — isActive()/getSubscription() tidak berubah sehingga
   *   grey badge, fee waiver, dll. jalan terus sampai periode berakhir.
   * - Scheduler expiry: saat periode berakhir langsung EXPIRED (tanpa grace).
   *
   * Batalkan pembatalan via reactivate() selama periode masih berjalan.
   */
  async cancel(userId: string): Promise<Subscription> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { userId, status: SubscriptionStatus.ACTIVE },
    });

    if (!subscription) {
      throw new NotFoundException({
        code: ErrorCodes.NO_ACTIVE_SUBSCRIPTION,
        message: 'No active subscription found',
      });
    }
    if (subscription.cancelAtPeriodEnd) {
      throw new ConflictException({
        code: ErrorCodes.INVALID_STATUS,
        message: 'Subscription is already scheduled for cancellation at period end',
      });
    }

    const updated = await this.prisma.$transaction(
      async tx => {
        const result = await tx.subscription.updateMany({
          where: { id: subscription.id, status: SubscriptionStatus.ACTIVE, cancelAtPeriodEnd: false },
          data: {
            cancelAtPeriodEnd: true,
            isAutoRenew: false,
            cancelledAt: new Date(),
            cancelReason: 'User requested cancellation (at period end)',
          },
        });
        if (result.count === 0) {
          throw new ConflictException({
            code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
            message: 'Subscription changed concurrently — please retry',
          });
        }
        const sub = await tx.subscription.findUniqueOrThrow({ where: { id: subscription.id } });

        // Status tetap ACTIVE — benefit dicabut scheduler saat currentPeriodEnd
        // lewat (subscription-expiry.service.ts). Jangan clear isKahadePlus di sini.

        return sub;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    // AUDIT-24: drop the 300 s order-creation cache as soon as entitlement changes.
    await this.redis.del(`subscription_status:${userId}`).catch(() => undefined);
    // Benefit bertahan sampai akhir periode, tapi badge cache tetap di-refresh
    // supaya state terbaru terbaca tanpa menunggu TTL.
    await this.verificationBadgeService.invalidate(userId);

    this.auditLogService.logUserAction({
      userId,
      action: UserAuditAction.SUBSCRIPTION_CANCELLED,
      entityType: 'Subscription',
      entityId: updated.id,
      description: `Cancelled ${updated.plan} subscription (effective at period end ${updated.currentPeriodEnd?.toISOString()})`,
    });

    return updated;
  }

  /**
   * Membatalkan pembatalan: user berubah pikiran sebelum periode berakhir.
   * Mengembalikan cancelAtPeriodEnd=false dan menyalakan auto-renew kembali.
   */
  async reactivate(userId: string): Promise<Subscription> {
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        userId,
        status: SubscriptionStatus.ACTIVE,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: { gt: new Date() },
      },
    });

    if (!subscription) {
      throw new NotFoundException({
        code: ErrorCodes.NO_ACTIVE_SUBSCRIPTION,
        message: 'No cancellable subscription found to reactivate',
      });
    }

    const updated = await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        cancelAtPeriodEnd: false,
        isAutoRenew: true,
        cancelledAt: null,
        cancelReason: null,
      },
    });

    await this.redis.del(`subscription_status:${userId}`).catch(() => undefined);
    await this.verificationBadgeService.invalidate(userId);

    this.auditLogService.logUserAction({
      userId,
      action: UserAuditAction.SUBSCRIPTION_AUTO_RENEW_TOGGLED,
      entityType: 'Subscription',
      entityId: updated.id,
      description: `Reactivated ${updated.plan} subscription (cancellation undone)`,
    });

    return updated;
  }

  async pause(userId: string, resumeAt?: Date): Promise<Subscription> {
    if (resumeAt !== undefined && (!Number.isFinite(resumeAt.getTime()) || resumeAt <= new Date())) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_DATE_RANGE, message: 'resumeAt must be a future date' });
    }
    const subscription = await this.prisma.subscription.findFirst({
      where: { userId, status: SubscriptionStatus.ACTIVE, currentPeriodEnd: { gt: new Date() } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (!subscription) {
      throw new NotFoundException({ code: ErrorCodes.NO_ACTIVE_SUBSCRIPTION, message: 'No active subscription found' });
    }

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const result = await tx.subscription.updateMany({
        where: { id: subscription.id, status: SubscriptionStatus.ACTIVE, currentPeriodEnd: { gt: now } },
        data: {
          status: SubscriptionStatus.PAUSED,
          pausedAt: now,
          resumeAt: resumeAt ?? null,
          isAutoRenew: false,
        },
      });
      if (result.count === 0) {
        throw new ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Subscription changed concurrently — please retry' });
      }
      await tx.user.update({
        where: { id: userId },
        data: { isKahadePlus: false },
      });
      return tx.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    await this.redis.del(`subscription_status:${userId}`).catch(() => undefined);
    await this.verificationBadgeService.invalidate(userId);
    this.auditLogService.logUserAction({
      userId,
      action: UserAuditAction.SUBSCRIPTION_CANCELLED,
      entityType: 'Subscription',
      entityId: updated.id,
      description: `Paused ${updated.plan} subscription`,
    });
    return updated;
  }

  async resume(userId: string): Promise<Subscription> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { userId, status: SubscriptionStatus.PAUSED, currentPeriodEnd: { gt: new Date() } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (!subscription) {
      throw new NotFoundException({ code: ErrorCodes.NO_ACTIVE_SUBSCRIPTION, message: 'No paused subscription found' });
    }
    return this.resumeSubscriptionById(subscription.id);
  }

  async resumeSubscriptionById(subscriptionId: string): Promise<Subscription> {
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const subscription = await tx.subscription.findUnique({ where: { id: subscriptionId } });
      if (!subscription || subscription.status !== SubscriptionStatus.PAUSED || !subscription.currentPeriodEnd || subscription.currentPeriodEnd <= now) {
        throw new NotFoundException({ code: ErrorCodes.NO_ACTIVE_SUBSCRIPTION, message: 'No resumable subscription found' });
      }
      const result = await tx.subscription.updateMany({
        where: { id: subscription.id, status: SubscriptionStatus.PAUSED, currentPeriodEnd: { gt: now } },
        data: { status: SubscriptionStatus.ACTIVE, pausedAt: null, resumeAt: null },
      });
      if (result.count === 0) {
        throw new ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Subscription changed concurrently — please retry' });
      }
      await tx.user.update({
        where: { id: subscription.userId },
        data: { isKahadePlus: true, subscriptionExpiresAt: subscription.currentPeriodEnd },
      });
      return tx.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    await this.redis.del(`subscription_status:${updated.userId}`).catch(() => undefined);
    await this.verificationBadgeService.invalidate(updated.userId);
    this.auditLogService.logUserAction({
      userId: updated.userId,
      action: UserAuditAction.SUBSCRIPTION_STARTED,
      entityType: 'Subscription',
      entityId: updated.id,
      description: `Resumed ${updated.plan} subscription`,
    });
    return updated;
  }

  async getHistory(
    userId: string,
    page: number,
    limit: number,
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    const safePage = Math.max(1, Number.isFinite(page) ? Math.trunc(page) : 1);
    const safeLimit = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 20));
    const skip = (safePage - 1) * safeLimit;

    const [data, total] = await Promise.all([
      this.prisma.subscription.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: safeLimit,
      }),
      this.prisma.subscription.count({ where: { userId } }),
    ]);

    const serialized = data.map(sub => ({
      id: sub.id,
      plan: sub.plan,
      status: sub.status,
      price: toIdr(sub.price),
      originalPrice: sub.originalPrice != null ? toIdr(sub.originalPrice) : null,
      pausedAt: sub.pausedAt,
      resumeAt: sub.resumeAt,
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
      isAutoRenew: sub.isAutoRenew,
      cancelledAt: sub.cancelledAt,
      lastPaymentAt: sub.lastPaymentAt,
      feeSavingsUsed: toIdr(sub.feeSavingsUsed),
      feeSavingsLimit: toIdr(sub.feeSavingsLimit),
      createdAt: sub.createdAt,
    }));

    return createPaginatedResponse(serialized, total, safePage, safeLimit);
  }

  async getBenefits(userId: string): Promise<Record<string, unknown>> {
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        userId,
        status: {
          in: [
            SubscriptionStatus.ACTIVE,
            SubscriptionStatus.CANCELLED,
            SubscriptionStatus.SUSPENDED,
          ],
        },
        currentPeriodEnd: { gt: new Date() },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    if (!subscription) {
      throw new NotFoundException({
        code: ErrorCodes.NO_ACTIVE_SUBSCRIPTION,
        message: 'No active subscription found',
      });
    }

    const planInfo = this.planPricing[subscription.plan];
    const feeSavingsRemaining =
      subscription.feeSavingsLimit > subscription.feeSavingsUsed
        ? subscription.feeSavingsLimit - subscription.feeSavingsUsed
        : BigInt(0);

    return {
      plan: subscription.plan,
      label: planInfo.label,
      // SP-010: benefit dari source of truth backend (bukan hardcode inline).
      benefits: KAHADE_PLUS_BENEFITS,
      feeSavingsUsed: toIdr(subscription.feeSavingsUsed),
      feeSavingsLimit: toIdr(subscription.feeSavingsLimit),
      feeSavingsRemaining: toIdr(feeSavingsRemaining),
      currentPeriodEnd: subscription.currentPeriodEnd,
    };
  }

  async renew(userId: string, pin: string, ip?: string): Promise<Subscription> {
    // Misi tanpa-wallet (BI-safe): renew via wallet MATI saat kill-switch mati.
    // Gunakan POST /v1/subscriptions/renew-dana (bayar DANA langsung).
    if (!this.walletMode.isWalletEnabled()) {
      throw new BadRequestException({
        code: 'WALLET_DISABLED_USE_DANA',
        message: 'Wallet renewal is disabled — use renew-dana',
      });
    }
    await this.walletService.verifyPin(userId, pin, ip);

    const subscription = await this.prisma.subscription.findFirst({
      where: {
        userId,
        status: {
          in: [
            SubscriptionStatus.ACTIVE,
            SubscriptionStatus.CANCELLED,
            SubscriptionStatus.SUSPENDED,
          ],
        },
        currentPeriodEnd: { gt: new Date() },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    if (!subscription) {
      throw new NotFoundException({
        code: ErrorCodes.NO_ACTIVE_SUBSCRIPTION,
        message: 'No active subscription found',
      });
    }
    if (
      subscription.status === SubscriptionStatus.CANCELLED &&
      subscription.cancelReason === 'Force cancelled by admin'
    ) {
      throw new ConflictException({
        code: ErrorCodes.INVALID_STATUS,
        message: 'This subscription was cancelled by an administrator',
      });
    }

    const planInfo = this.planPricing[subscription.plan];
    const walletTxSerial = await this.walletTxSerialService.getNext();
    const renewBase =
      subscription.status === SubscriptionStatus.SUSPENDED
        ? new Date()
        : new Date(subscription.currentPeriodEnd ?? new Date());
    const newPeriodEnd = new Date(renewBase);
    newPeriodEnd.setDate(newPeriodEnd.getDate() + planInfo.durationDays);
    const now = new Date();

    const updated = await this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const walletRows = await tx.$queryRaw<
          Array<{
            id: string;
            userId: string;
            totalBalance: bigint;
            availableBalance: bigint;
            version: number;
          }>
        >`
        SELECT id, "userId", "totalBalance", "availableBalance", version FROM wallets WHERE "userId" = ${userId} FOR UPDATE`;
        const wallet = walletRows[0];
        if (!wallet) {
          throw new BadRequestException({
            code: ErrorCodes.INSUFFICIENT_BALANCE,
            message: 'Wallet not found',
          });
        }

        if (wallet.availableBalance < planInfo.price) {
          throw new BadRequestException({
            code: ErrorCodes.INSUFFICIENT_BALANCE,
            message: 'Insufficient wallet balance for subscription renewal',
          });
        }

        const walletUpdated = await tx.wallet.updateMany({
          where: {
            id: wallet.id,
            version: wallet.version,
            availableBalance: { gte: planInfo.price },
          },
          data: {
            availableBalance: { decrement: planInfo.price },
            totalBalance: { decrement: planInfo.price },
            version: { increment: 1 },
          },
        });

        if (walletUpdated.count === 0) {
          throw new BadRequestException({
            code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
            message: 'Concurrent wallet update — please retry',
          });
        }

        const walletTxId = generateWalletTxId(walletTxSerial);
        const renewBalanceBefore = wallet.totalBalance;
        const renewBalanceAfter = wallet.totalBalance - planInfo.price;
        await tx.walletTransaction.create({
          data: {
            txId: walletTxId,
            walletId: wallet.id,
            type: WalletTransactionType.SUBSCRIPTION_PAYMENT,
            status: WalletTransactionStatus.SUCCESS,
            amount: planInfo.price,
            balanceBefore: renewBalanceBefore,
            balanceAfter: renewBalanceAfter,
            description: `${planInfo.label} subscription renewal`,
          },
        });

        const feeSavingsLimitIdr = this.configService.get<number>('app.feeSavingsLimit') ?? 5000000;
        const feeSavingsLimitSen = toSen(feeSavingsLimitIdr);

        const subUpdated = await tx.subscription.updateMany({
          where: {
            id: subscription.id,
            status: {
              in: [
                SubscriptionStatus.ACTIVE,
                SubscriptionStatus.CANCELLED,
                SubscriptionStatus.SUSPENDED,
              ],
            },
            currentPeriodEnd: subscription.currentPeriodEnd,
          },
          data: {
            status: SubscriptionStatus.ACTIVE,
            isAutoRenew: subscription.isAutoRenew,
            currentPeriodStart: now,
            currentPeriodEnd: newPeriodEnd,
            lastPaymentAt: now,
            nextPaymentAt: newPeriodEnd,
            feeSavingsUsed: BigInt(0),
            feeSavingsLimit: feeSavingsLimitSen,
            cancelledAt: null,
            cancelReason: null,
          },
        });
        if (subUpdated.count === 0) {
          throw new ConflictException({
            code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
            message: 'Subscription was already renewed — please retry',
          });
        }
        const sub = await tx.subscription.findUniqueOrThrow({ where: { id: subscription.id } });

        await tx.user.update({
          where: { id: userId },
          data: {
            isKahadePlus: true,
            subscriptionExpiresAt: newPeriodEnd,
            // Renewal tidak mengubah kahadePlusSince, kecuali akun legacy yang
            // belum punya nilainya (kolom ini baru ada sejak Section 1).
            ...(await this.buildKahadePlusSinceData(tx, userId, new Date())),
          },
        });

        return sub;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    // AUDIT-24: see subscribe() — keep order-fee decisions honest after renewal.
    await this.redis.del(`subscription_status:${userId}`).catch(() => undefined);
    await this.verificationBadgeService.invalidate(userId);
    this.logger.log(`User ${userId} renewed ${subscription.plan}, charged ${planInfo.price} sen`);
    this.auditLogService.logUserAction({
      userId,
      action: UserAuditAction.SUBSCRIPTION_STARTED,
      entityType: 'Subscription',
      entityId: subscription.id,
      description: `Renewed ${subscription.plan} subscription (previous feeSavingsUsed: ${subscription.feeSavingsUsed ?? 0} sen)`,
    });
    return updated;
  }

  async getPlans(): Promise<
    Array<{
      plan: string;
      label: string;
      price: number;
      durationDays: number;
      feeSavingsLimit: number;
      // SP-010: source of truth benefit backend (aditif).
      benefits: SubscriptionBenefit[];
    }>
  > {
    type PlanEntry = {
      plan: string;
      label: string;
      price: number;
      durationDays: number;
      feeSavingsLimit: number;
      benefits: SubscriptionBenefit[];
    };
    const cacheKey = `${SUBSCRIPTION_PLANS_CACHE}:plans`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as PlanEntry[];
      } catch (_) {
        await this.redis.del(cacheKey);
      }
    }
    const feeSavingsLimit = this.configService.get<number>('app.feeSavingsLimit') ?? 5000000;
    const plans = Object.entries(this.planPricing).map(([plan, info]) => ({
      plan,
      label: info.label,
      price: toIdr(info.price),
      durationDays: info.durationDays,
      feeSavingsLimit,
      // SP-010: source of truth benefit backend — aditif, frontend tidak
      // perlu hardcode daftar benefit lagi.
      benefits: KAHADE_PLUS_BENEFITS,
    }));
    await this.redis.setex(cacheKey, SUBSCRIPTION_PLANS_TTL, JSON.stringify(plans));
    return plans;
  }

  // 11.1 Subscription upgrade proration
  async upgradeSubscription(userId: string, newPlan: SubscriptionPlan, pin: string, ip?: string): Promise<object> {
    await this.walletService.verifyPin(userId, pin, ip);
    const current = await this.prisma.subscription.findFirst({
      where: { userId, status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.CANCELLED] }, currentPeriodEnd: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!current) throw new NotFoundException({ code: ErrorCodes.NO_ACTIVE_SUBSCRIPTION, message: 'No active subscription' });
    if (!current.currentPeriodStart || !current.currentPeriodEnd) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Subscription period is not initialized' });
    }
    if (current.plan === newPlan) throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Already on this plan' });

    const currentPlanInfo = this.planPricing[current.plan];
    const newPlanInfo = this.planPricing[newPlan];
    if (!newPlanInfo) throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid plan' });

    // Proration: calculate remaining value of current plan
    const now = new Date();
    const totalDuration = current.currentPeriodEnd.getTime() - current.currentPeriodStart.getTime();
    const remaining = current.currentPeriodEnd.getTime() - now.getTime();
    const remainingRatio = remaining / totalDuration;
    const remainingValue = BigInt(Math.floor(Number(current.price) * remainingRatio));
    const priceDiff = newPlanInfo.price - remainingValue;
    const chargeAmount = priceDiff > 0 ? priceDiff : BigInt(0);

    if (chargeAmount > 0) {
      const walletRows = await this.prisma.$queryRaw<Array<{ id: string; totalBalance: bigint; availableBalance: bigint; version: number }>>`
        SELECT id, \"totalBalance\", \"availableBalance\", version FROM wallets WHERE \"userId\" = ${userId} FOR UPDATE
      `;
      const wallet = walletRows[0];
      if (!wallet || wallet.availableBalance < chargeAmount) throw new BadRequestException({ code: ErrorCodes.INSUFFICIENT_BALANCE, message: 'Insufficient balance for upgrade' });
    }

    const serial = await this.walletTxSerialService.getNext();
    const updated = await this.prisma.$transaction(async (tx) => {
      if (chargeAmount > 0) {
        const w = await tx.wallet.findUnique({ where: { userId } });
        if (!w) throw new BadRequestException({ code: ErrorCodes.WALLET_NOT_FOUND, message: 'Wallet not found' });
        await tx.wallet.update({ where: { id: w.id }, data: { availableBalance: { decrement: chargeAmount }, totalBalance: { decrement: chargeAmount }, version: { increment: 1 } } });
        await tx.walletTransaction.create({
          data: {
            txId: generateWalletTxId(serial),
            walletId: w.id,
            type: WalletTransactionType.SUBSCRIPTION_PAYMENT,
            status: WalletTransactionStatus.SUCCESS,
            amount: chargeAmount,
            balanceBefore: w.totalBalance,
            balanceAfter: w.totalBalance - chargeAmount,
            description: `Upgrade from ${current.plan} to ${newPlan} (prorated)`,
          },
        });
      }
      const newEnd = new Date(now);
      newEnd.setDate(newEnd.getDate() + newPlanInfo.durationDays);
      const sub = await tx.subscription.update({
        where: { id: current.id },
        data: {
          plan: newPlan,
          price: newPlanInfo.price,
          currentPeriodStart: now,
          currentPeriodEnd: newEnd,
          nextPaymentAt: newEnd,
        },
      });
      await tx.user.update({ where: { id: userId }, data: { subscriptionExpiresAt: newEnd } });
      return sub;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    await this.redis.del(`subscription_status:${userId}`).catch(() => {});
    await this.verificationBadgeService.invalidate(userId);
    return { subscription: updated, charged: toIdr(chargeAmount), proratedCredit: toIdr(remainingValue) };
  }
}
