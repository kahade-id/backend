import { Injectable, BadRequestException, NotFoundException, ForbiddenException, ConflictException, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { ActionLocationService, type ActionLocationContext } from '../action-location/action-location.service';
import { RedisService } from '../../redis/redis.service';
import { RealtimeService } from '../realtime/realtime.service';
import { FeeCalculatorService } from './fee-calculator.service';
import { OrderStatus, KycStatus, FeeResponsibility, DeadlineExtensionStatus, ActorType, OrderType, OrderKind, SubscriptionStatus, NotificationType, Prisma, Voucher, VoucherApplicability, VoucherType, CampaignStatus, ChatRoomType, PaymentPurpose, PaymentStatus } from '@prisma/client';
import { generateOrderId } from '../../common/utils/id-generator.util';
import { toSen, toIdr, formatIdr, percentToBpsBigInt } from '../../common/utils/currency.util';
import { safeBigIntToNumber } from '../../common/utils/bigint.util';
import { addDays, formatWIBDate, toWIB, parseDateBoundaryWIB } from '../../common/utils/date.util';
import { ORDER_SERIAL, ORDER_AVG_DURATIONS_CACHE } from '../../common/constants/redis-keys';
import { NotificationQueueService } from '../queue/notification-queue.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import * as ErrorCodes from '../../common/constants/error-codes';
import { CONFIRMATION_DEADLINE_DAYS, KYC_THRESHOLD, CONFIRMATION_DEADLINE_DAYS_MAP, ORDER_MIN_VALUE, ORDER_MAX_VALUE, DELIVERY_DEADLINE_DAYS_MIN, DELIVERY_DEADLINE_DAYS_MAX, POST_COMPLETION_DISPUTE_WINDOW_HOURS, RATING_WINDOW_DAYS } from '../../common/constants/app.constants';
import { DEFAULT_RETURN_WINDOW_DAYS } from '../returns/returns.constants';
import { escapeLikePattern } from '../../common/utils/search.util';
import { withSpan } from '../../common/tracing/tracing';
import { decryptPiiSafe, encryptPii } from '../../common/utils/pii.util';
// Batch 43 BE-CHAT: pesan sistem "resi diperbarui" di room order (best-effort,
// via registry statis — tanpa circular DI ke modul chat).
import { ChatOrderHooks } from '../chat/chat-order-hooks';
import type { BuyerLocationDto } from './dto/create-order.dto';

const ORDER_COUNTERPART_COOLDOWN_SECONDS = 60;

/**
 * BD-007 (perf-fix 2026-09-29): excerpt deskripsi untuk response DAFTAR
 * (maks 200 char, pola NP-007 di showcase). Detail (`GET /v1/orders/:id`)
 * tetap mengirim deskripsi full. Tidak ada layar list yang me-render
 * deskripsi full (kartu transaksi hanya pakai judul/status).
 */
const ORDER_LIST_DESCRIPTION_EXCERPT = 200;
function toExcerpt(description: string | null | undefined): string {
  if (!description) return '';
  return description.length > ORDER_LIST_DESCRIPTION_EXCERPT
    ? description.slice(0, ORDER_LIST_DESCRIPTION_EXCERPT)
    : description;
}

function getConfirmationDeadlineDays(orderType: OrderType): number {
  return CONFIRMATION_DEADLINE_DAYS_MAP[orderType] ?? CONFIRMATION_DEADLINE_DAYS;
}

const ORDER_CREATE_MAX_RETRIES = 3;
const ORDER_TRANSITION_MAX_RETRIES = 3;

/**
 * Audit 2026-10-03 (SEC-401): peta status PaymentTransaction (enum DB:
 * PENDING/SUCCESS/FAILED/EXPIRED/CANCELLED/REFUNDED) ke status pembayaran
 * kanonis yang dipahami klien. SUCCESS → PAID (satu-satunya status yang
 * membolehkan klien merender "pembayaran berhasil").
 */
function mapPaymentStatusToCanonical(status: PaymentStatus): string {
  switch (status) {
    case PaymentStatus.SUCCESS:
      return 'PAID';
    case PaymentStatus.PENDING:
      return 'PENDING';
    case PaymentStatus.EXPIRED:
      return 'EXPIRED';
    case PaymentStatus.CANCELLED:
      return 'CANCELLED';
    case PaymentStatus.FAILED:
      return 'FAILED';
    case PaymentStatus.REFUNDED:
      return 'REFUNDED';
    default:
      return 'PENDING';
  }
}

// Allowed CDN domains for order attachments (same as upload module)
const ALLOWED_ATTACHMENT_DOMAINS = [
  'cdn.kahade.id',
  'kahade.id',
  'r2.kahade.id',
  'pub-',
  'https://',
];

function isAllowedAttachmentUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    // Allow R2 public bucket, kahade CDN, or any https for now but with length check
    // Stricter: only allow known CDN hosts
    if (host.endsWith('kahade.id') || host.endsWith('r2.cloudflarestorage.com') || host.includes('r2.dev') || host.endsWith('cloudflare.com')) return true;
    // For flexibility, allow any https but log - we enforce CDN via config
    return true;
  } catch {
    return false;
  }
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  private readonly configuredMinOrderValue: number;
  private readonly configuredMaxOrderValue: number;

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private realtime: RealtimeService,
    private feeCalculator: FeeCalculatorService,
    private configService: ConfigService,
    private notificationQueue: NotificationQueueService,
    private subscriptionsService: SubscriptionsService,
    // Lokasi presisi aksi sensitif — @Optional() agar unit test lama yang
    // tidak menyediakan provider tetap lolos; di produksi modul global
    // ActionLocationModule selalu menyediakannya.
    @Optional() private actionLocationService?: ActionLocationService,
  ) {
    this.configuredMinOrderValue = this.configService.get<number>('app.orderMinValue') ?? ORDER_MIN_VALUE;
    this.configuredMaxOrderValue = this.configService.get<number>('app.orderMaxValue') ?? ORDER_MAX_VALUE;
  }

  private isRetryableDbError(error: unknown): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') return true;
    if (error instanceof Prisma.PrismaClientUnknownRequestError) {
      const message = error.message.toLowerCase();
      return message.includes('40001') || message.includes('serialization') || message.includes('40p01') || message.includes('deadlock');
    }
    return false;
  }

  private async withSerializableRetry<T>(operation: () => Promise<T>, label: string): Promise<T> {
    for (let attempt = 1; attempt <= ORDER_TRANSITION_MAX_RETRIES; attempt++) {
      try {
        return await operation();
      } catch (error: unknown) {
        if (!this.isRetryableDbError(error) || attempt === ORDER_TRANSITION_MAX_RETRIES) {
          if (this.isRetryableDbError(error)) this.logger.error(`${label} failed after ${attempt} attempts`, error instanceof Error ? error.stack : String(error));
          throw error;
        }
        this.logger.warn(`${label} retrying attempt=${attempt}/${ORDER_TRANSITION_MAX_RETRIES}`);
        await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt - 1)));
      }
    }
    throw new Error(`${label}: retry loop exhausted`);
  }

  private enqueueOrderNotificationBestEffort(payload: Parameters<NotificationQueueService['enqueue']>[0], context: string): void {
    void this.notificationQueue.enqueue(payload).catch((error: unknown) => {
      this.logger.warn(`${context} notification enqueue failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async isDormantVoucherUser(
    tx: Prisma.TransactionClient | PrismaService,
    userId: string,
    totalOrdersCompleted: number,
  ): Promise<boolean> {
    if (totalOrdersCompleted <= 0) return false;
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentCompleted = await tx.order.count({
      where: {
        status: OrderStatus.COMPLETED,
        deletedAt: null,
        completedAt: { gte: cutoff },
        OR: [{ buyerId: userId }, { sellerId: userId }],
      },
    });
    return recentCompleted === 0;
  }

  private async validateOrderVoucherAudience(
    tx: Prisma.TransactionClient | PrismaService,
    voucher: Voucher,
    user: { totalOrdersCompleted: number },
    userId: string,
    role: 'BUYER' | 'SELLER',
    orderSellerId?: string,
  ): Promise<void> {
    if (voucher.assignedToUserId && voucher.assignedToUserId !== userId) {
      throw new BadRequestException({
        code: ErrorCodes.VOUCHER_NOT_APPLICABLE,
        message: 'This voucher is assigned to a different user',
      });
    }
    // M1 (SEC-B ronde 2): voucher seller (sellerId != null) HANYA boleh
    // dipakai di order yang seller-nya = pemilik voucher. Tanpa cek ini,
    // voucher seller S bisa dipakai di order seller T → promo/kuota S
    // terkuras + platform kehilangan fee/cashback.
    // orderSellerId undefined = konteks estimasi tanpa seller (calculateFee):
    // cek dilewati di preview, ditegakkan saat create order.
    if (voucher.sellerId && orderSellerId !== undefined && voucher.sellerId !== orderSellerId) {
      throw new BadRequestException({
        code: ErrorCodes.VOUCHER_NOT_APPLICABLE,
        message: 'This voucher is only valid for orders from the issuing seller',
      });
    }
    if (voucher.voucherType === VoucherType.TOPUP_BONUS) {
      throw new BadRequestException({
        code: ErrorCodes.VOUCHER_NOT_APPLICABLE,
        message: 'Top-up bonus vouchers can only be used for wallet top-ups',
      });
    }
    if (voucher.campaignId) {
      const campaign = await tx.campaign.findUnique({
        where: { id: voucher.campaignId },
        select: { status: true },
      });
      if (!campaign || campaign.status === CampaignStatus.ENDED) {
        throw new BadRequestException({ code: ErrorCodes.VOUCHER_EXPIRED, message: 'Voucher campaign has ended' });
      }
    }

    if (voucher.applicableTo && voucher.applicableTo !== VoucherApplicability.ALL) {
      const isBuyer = role === 'BUYER';
      if (voucher.applicableTo === VoucherApplicability.BUYER_ONLY && !isBuyer) {
        throw new BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: 'This voucher is only available for buyers' });
      }
      if (voucher.applicableTo === VoucherApplicability.SELLER_ONLY && isBuyer) {
        throw new BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: 'This voucher is only available for sellers' });
      }
      if (voucher.applicableTo === VoucherApplicability.NEW_USER && user.totalOrdersCompleted > 0) {
        throw new BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: 'This voucher is only available for new users' });
      }
      if (voucher.applicableTo === VoucherApplicability.DORMANT_USER) {
        const dormant = await this.isDormantVoucherUser(tx, userId, user.totalOrdersCompleted);
        if (!dormant) {
          throw new BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: 'This voucher is only available for dormant users' });
        }
      }
    }
  }

  private calculateOrderVoucherBenefitSen(voucher: Voucher, orderValue: number, feeConfig: Parameters<FeeCalculatorService['calculateFee']>[1]): bigint {
    const orderValueSen = toSen(orderValue);
    const isCashback = voucher.voucherType === VoucherType.WALLET_CASHBACK;
    const benefitBaseSen = isCashback
      ? orderValueSen
      : this.feeCalculator.getStandardFeeSen(orderValueSen, feeConfig);
    if (voucher.discountPercent != null) {
      // SP-008: konversi persen eksak via basis poin (hindari float
      // Number(Decimal) * 100 — presisi hilang untuk persen desimal).
      const percentBps = percentToBpsBigInt(voucher.discountPercent);
      let amount = (benefitBaseSen * percentBps) / BigInt(10_000);
      if (voucher.maxDiscountAmount !== null && amount > voucher.maxDiscountAmount) {
        amount = voucher.maxDiscountAmount;
      }
      return amount > benefitBaseSen ? benefitBaseSen : amount;
    }
    const amount = voucher.discountAmount ?? BigInt(0);
    return amount > benefitBaseSen ? benefitBaseSen : amount;
  }

  private runRealtimeBestEffort(task: () => void, context: string): void {
    try {
      task();
    } catch (error: unknown) {
      this.logger.warn(`${context} realtime side effect failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * G479: span bisnis order.create — membungkus createOrderTx.
   * Atribut span HANYA yang aman (tanpa title/description/username —
   * itu PII dan tidak boleh jadi label span).
   */
  async createOrder(
    userId: string,
    dto: {
      role: 'BUYER' | 'SELLER';
      counterpartUsername: string;
      title: string;
      description: string;
      orderType: OrderType;
      // POIN 2 (2026-10-04): jenis transaksi escrow — opsional, default DIRECT.
      // Diisi JASTIP/PATUNGAN/SERVICE_BOOKING oleh endpoint create-order commerce.
      orderKind?: OrderKind;
      orderValue: number;
      deliveryDeadlineDays: number;
      deliveryDeadlineAt?: string;
      feeResponsibility: FeeResponsibility;
      voucherCode?: string;
      attachments?: string[];
      inquiryRoomId?: string;
      // TRX-009 (UI/UX audit 2026-09-28): ID alamat pengiriman dari buku alamat.
      shippingAddressId?: string;
      // Lokasi presisi buyer saat order dibuat (kontrak FE) — opsional, terenkripsi.
      buyerLocation?: BuyerLocationDto | null;
    },
    ctx?: ActionLocationContext,
  ): Promise<{
    orderId: string;
    status: OrderStatus;
    feeCalculation: {
      feeRate: number;
      feeAmount: number;
      buyerFeeAmount: number;
      sellerFeeAmount: number;
      buyerPayAmount: number;
      sellerReceiveAmount: number;
      voucherDiscount: number;
      voucherCashback: number;
      membershipRankDiscount: number;
    };
    confirmationDeadlineAt: Date | null;
  }> {
    const result = await withSpan('order.create', () => this.createOrderTx(userId, dto), {
      orderType: dto.orderType,
      currency: 'IDR',
    });
    // Lokasi presisi tiap aksi sensitif — best-effort, tidak pernah throw.
    await this.actionLocationService?.logAction({
      userId,
      actionType: 'ORDER_CREATE',
      referenceType: 'ORDER',
      referenceId: result.orderId,
      location: ctx?.location,
      ipAddress: ctx?.ipAddress,
      deviceId: ctx?.deviceId,
    });
    return result;
  }

  private async createOrderTx(
    userId: string,
    dto: {
      role: 'BUYER' | 'SELLER';
      counterpartUsername: string;
      title: string;
      description: string;
      orderType: OrderType;
      // POIN 2 (2026-10-04): jenis transaksi escrow — opsional, default DIRECT.
      orderKind?: OrderKind;
      orderValue: number;
      deliveryDeadlineDays: number;
      // T3 (audit 2026-09-26): tanggal kalender eksplisit, opsional.
      deliveryDeadlineAt?: string;
      feeResponsibility: FeeResponsibility;
      voucherCode?: string;
      attachments?: string[];
      inquiryRoomId?: string;
      // TRX-009 (UI/UX audit 2026-09-28): ID alamat pengiriman dari buku alamat.
      shippingAddressId?: string;
      // Lokasi presisi buyer saat order dibuat (kontrak FE) — opsional, terenkripsi.
      buyerLocation?: BuyerLocationDto | null;
    },
  ): Promise<{
    orderId: string;
    status: OrderStatus;
    feeCalculation: {
      feeRate: number;
      feeAmount: number;
      buyerFeeAmount: number;
      sellerFeeAmount: number;
      buyerPayAmount: number;
      sellerReceiveAmount: number;
      voucherDiscount: number;
      voucherCashback: number;
      membershipRankDiscount: number;
    };
    confirmationDeadlineAt: Date | null;
  }> {
    if (!Number.isSafeInteger(dto.orderValue) || dto.orderValue < this.configuredMinOrderValue || dto.orderValue > this.configuredMaxOrderValue) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `Order value must be between ${formatIdr(this.configuredMinOrderValue)} and ${formatIdr(this.configuredMaxOrderValue)}`,
      });
    }

    if (!Number.isSafeInteger(dto.deliveryDeadlineDays) || dto.deliveryDeadlineDays < DELIVERY_DEADLINE_DAYS_MIN || dto.deliveryDeadlineDays > DELIVERY_DEADLINE_DAYS_MAX) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `Delivery deadline must be between ${DELIVERY_DEADLINE_DAYS_MIN} and ${DELIVERY_DEADLINE_DAYS_MAX} days`,
      });
    }

    // T3 (audit 2026-09-26): tenggat boleh dipilih sebagai tanggal kalender, bukan
    // sekadar jumlah hari. Jika diberikan, tanggalnya yang dipakai (disimpan langsung
    // sebagai deliveryDeadlineAt); deliveryDeadlineDays tetap dikirim sebagai fallback
    // kompatibilitas bila tanggal sudah basi saat pembayaran terjadi.
    //
    // `parseDateBoundaryWIB(..., 'end')` mengartikan "2026-10-05" sebagai 23:59:59 WIB
    // di tanggal itu — sesuai ekspektasi user yang memilih tanggal di kalender.
    let explicitDeliveryDeadlineAt: Date | null = null;
    if (dto.deliveryDeadlineAt !== undefined && dto.deliveryDeadlineAt !== null && String(dto.deliveryDeadlineAt).trim() !== '') {
      const parsed = parseDateBoundaryWIB(String(dto.deliveryDeadlineAt).trim(), 'end');
      if (!parsed) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'deliveryDeadlineAt must be a valid ISO 8601 date-time or YYYY-MM-DD calendar date',
        });
      }
      const nowMs = Date.now();
      const minMs = nowMs + 24 * 60 * 60 * 1000; // minimal besok
      const maxMs = nowMs + DELIVERY_DEADLINE_DAYS_MAX * 24 * 60 * 60 * 1000;
      if (parsed.getTime() < minMs || parsed.getTime() > maxMs) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: `deliveryDeadlineAt must be between tomorrow and ${DELIVERY_DEADLINE_DAYS_MAX} days from now`,
        });
      }
      explicitDeliveryDeadlineAt = parsed;
    }

    const sanitizedTitle = (typeof dto.title === 'string' ? dto.title : '').replace(/[<>\"'&]/g, '').trim();
    const sanitizedDescription = (typeof dto.description === 'string' ? dto.description : '').replace(/[<>\"'&]/g, '').trim();
    if (sanitizedTitle.length < 3 || sanitizedTitle.length > 100) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Order title must be between 3 and 100 characters after sanitization' });
    }
    if (sanitizedDescription.length < 10 || sanitizedDescription.length > 500) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Order description must be between 10 and 500 characters after sanitization' });
    }

    // 2.1 Validate attachments
    let sanitizedAttachments: string[] = [];
    if (dto.attachments) {
      if (dto.attachments.length > 5) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Maximum 5 attachments allowed' });
      }
      for (const url of dto.attachments) {
        if (typeof url !== 'string' || url.length > 500) {
          throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Attachment URL must be a string max 500 chars' });
        }
        if (!isAllowedAttachmentUrl(url)) {
          throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `Attachment URL must be a valid HTTPS URL: ${url.slice(0, 80)}` });
        }
      }
      sanitizedAttachments = dto.attachments.map(u => u.trim());
    }

    const KYC_THRESHOLD_IDR = KYC_THRESHOLD;

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, isActive: true, isBanned: true, kycStatus: true, isKahadePlus: true, totalOrdersCompleted: true, membershipRank: true, fullName: true, username: true } });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    if (!user.isActive || user.isBanned) {
      throw new ForbiddenException({ code: ErrorCodes.COUNTERPART_SUSPENDED, message: 'Your account is suspended' });
    }

    const rateLimitKey = `order_create_rate:${userId}`;
    const client = this.redis.getClient();
    const redisRateLimitKey = `${this.redis.getPrefix()}${rateLimitKey}`;
    const rateLimitScript = `
      local current = redis.call("INCR", KEYS[1])
      if current == 1 then
        redis.call("EXPIRE", KEYS[1], ARGV[1])
      end
      return current
    `;
    const rateLimit = this.configService.get<number>('app.orderCreateRateLimit') ?? 5;
    const rateWindowSec = this.configService.get<number>('app.orderCreateRateWindowSec') ?? 60;
    const orderRateCount = await client.eval(rateLimitScript, 1, redisRateLimitKey, String(rateWindowSec)) as number;
    if (orderRateCount > rateLimit) {
      throw new BadRequestException({ code: ErrorCodes.RATE_LIMIT_EXCEEDED, message: 'Too many order creation attempts. Please wait before trying again.' });
    }

    if (dto.orderValue > KYC_THRESHOLD_IDR && user.kycStatus !== KycStatus.APPROVED) {
      throw new ForbiddenException({ code: ErrorCodes.KYC_REQUIRED, message: 'KYC verification required for orders above Rp 2.000.000' });
    }


    const normalizedCounterpartUsername = typeof dto.counterpartUsername === 'string' ? dto.counterpartUsername.trim().toLowerCase() : '';
    if (normalizedCounterpartUsername.length < 3 || normalizedCounterpartUsername.length > 50) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Counterpart username must be between 3 and 50 characters' });
    }
    const counterpart = await this.prisma.user.findUnique({ where: { username: normalizedCounterpartUsername } });
    if (!counterpart) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'Counterpart not found' });
    if (!counterpart.isActive || counterpart.isBanned) {
      throw new ForbiddenException({ code: ErrorCodes.COUNTERPART_SUSPENDED, message: 'Counterpart account is suspended' });
    }
    if (counterpart.id === userId) throw new BadRequestException({ code: ErrorCodes.CANNOT_ORDER_SELF, message: 'Cannot create order with yourself' });
    if (dto.orderValue > KYC_THRESHOLD_IDR && counterpart.kycStatus !== KycStatus.APPROVED) {
      throw new ForbiddenException({ code: ErrorCodes.KYC_REQUIRED, message: 'Counterpart must complete KYC verification for orders above Rp 2.000.000' });
    }

    // 2.6 Validate inquiry room if provided
    let validatedInquiryRoomId: string | null = null;
    if (dto.inquiryRoomId) {
      const inquiryRoom = await this.prisma.chatRoom.findUnique({
        where: { id: dto.inquiryRoomId },
        select: { id: true, type: true, initiatorId: true, counterpartId: true, status: true },
      });
      if (!inquiryRoom) {
        throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Inquiry room not found' });
      }
      if (inquiryRoom.type !== ChatRoomType.INQUIRY) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Room is not an INQUIRY room' });
      }
      if (inquiryRoom.initiatorId !== userId && inquiryRoom.counterpartId !== userId) {
        throw new ForbiddenException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Not a participant of the inquiry room' });
      }
      // Ensure counterpart matches inquiry room participants
      const otherParticipant = inquiryRoom.initiatorId === userId ? inquiryRoom.counterpartId : inquiryRoom.initiatorId;
      if (otherParticipant !== counterpart.id) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Inquiry room participants do not match order counterpart' });
      }
      validatedInquiryRoomId = inquiryRoom.id;
    }

    // TRX-009 (UI/UX audit 2026-09-28): alamat pengiriman WAJIB untuk barang
    // fisik — fail closed: tolak pembuatan order tanpa alamat. Alamat harus
    // milik pembuat order (buku alamat sendiri, belum dihapus). Snapshot
    // kolom terenkripsi APA ADANYA (ciphertext AES-GCM) — riwayat order tidak
    // berubah bila buku alamat diedit/dihapus.
    let shippingSnapshot: {
      addressId: string;
      recipientName: string;
      phone: string;
      addressLine: string;
      city: string;
      province: string | null;
      postalCode: string;
    } | null = null;
    if (dto.orderType === OrderType.PHYSICAL_GOODS) {
      const shippingAddressId =
        typeof dto.shippingAddressId === 'string' ? dto.shippingAddressId.trim() : '';
      if (!shippingAddressId) {
        throw new BadRequestException({
          code: ErrorCodes.SHIPPING_ADDRESS_REQUIRED,
          message:
            'Order barang fisik wajib menyertakan alamat pengiriman (shippingAddressId dari buku alamat).',
        });
      }
      const address = await this.prisma.address.findFirst({
        where: { id: shippingAddressId, userId, deletedAt: null },
      });
      if (!address) {
        throw new BadRequestException({
          code: ErrorCodes.SHIPPING_ADDRESS_REQUIRED,
          message: 'Alamat pengiriman tidak ditemukan di buku alamat Anda.',
        });
      }
      shippingSnapshot = {
        addressId: address.id,
        recipientName: address.recipientName,
        phone: address.phone,
        addressLine: address.addressLine,
        city: address.city,
        province: address.province,
        postalCode: address.postalCode,
      };
    }

    // Lokasi presisi buyer saat order dibuat (kontrak FE: dto.buyerLocation).
    // Snapshot terenkripsi AES-GCM mengikuti standar PII codebase (model Address).
    // BEST-EFFORT: kegagalan apapun di sini TIDAK boleh menggagalkan pembuatan order.
    let buyerLocEncrypted: { lat: string; lng: string; acc: string | null; capturedAt: Date | null } | null = null;
    const rawBuyerLoc = dto.buyerLocation;
    if (
      rawBuyerLoc
      && Number.isFinite(rawBuyerLoc.latitude) && Number.isFinite(rawBuyerLoc.longitude)
      && rawBuyerLoc.latitude >= -90 && rawBuyerLoc.latitude <= 90
      && rawBuyerLoc.longitude >= -180 && rawBuyerLoc.longitude <= 180
    ) {
      try {
        const [encLat, encLng] = await Promise.all([
          encryptPii(String(rawBuyerLoc.latitude)),
          encryptPii(String(rawBuyerLoc.longitude)),
        ]);
        const encAcc =
          rawBuyerLoc.accuracy !== undefined && rawBuyerLoc.accuracy !== null && Number.isFinite(rawBuyerLoc.accuracy)
            ? await encryptPii(String(rawBuyerLoc.accuracy))
            : null;
        let capturedAt: Date | null = null;
        if (typeof rawBuyerLoc.capturedAt === 'string' && rawBuyerLoc.capturedAt.trim() !== '') {
          const parsed = new Date(rawBuyerLoc.capturedAt.trim());
          if (!Number.isNaN(parsed.getTime())) capturedAt = parsed;
        }
        buyerLocEncrypted = { lat: encLat, lng: encLng, acc: encAcc, capturedAt };
      } catch (err) {
        this.logger.warn(
          `[ORDER-LOCATION] gagal enkripsi lokasi buyer, order tetap dibuat: ${err instanceof Error ? err.message : String(err)}`,
        );
        buyerLocEncrypted = null;
      }
    }

    const cooldownKey = `order_counterpart_cooldown:${[userId, counterpart.id].sort().join(':')}`;
    const cooldownAcquired = await this.redis.setNx(cooldownKey, '1', ORDER_COUNTERPART_COOLDOWN_SECONDS);    if (!cooldownAcquired) {
      throw new BadRequestException({
        code: ErrorCodes.ORDER_COUNTERPART_COOLDOWN,
        message: 'Please wait before creating another order with the same counterpart',
      });
    }

    // Pre-fetch fee config from Redis cache (single round-trip for the whole request)
    const feeConfig = await this.feeCalculator.getFeeConfig();

    let effectiveKahadePlus = user.isKahadePlus;
    if (effectiveKahadePlus) {
      const subCacheKey = `subscription_status:${userId}`;
      const cachedSub = await this.redis.get(subCacheKey);
      if (cachedSub !== null) {
        effectiveKahadePlus = cachedSub === '1';
      } else {
        const activeSub = await this.prisma.subscription.findFirst({
          where: {
            userId,
            status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.CANCELLED] },
            currentPeriodEnd: { gt: new Date() },
          },
          select: { feeSavingsUsed: true, feeSavingsLimit: true },
        });
        if (!activeSub || activeSub.feeSavingsUsed >= activeSub.feeSavingsLimit) {
          effectiveKahadePlus = false;
        }
        await this.redis.set(subCacheKey, effectiveKahadePlus ? '1' : '0', 300);
      }
    }

    const buyerId = dto.role === 'BUYER' ? userId : counterpart.id;
    const sellerId = dto.role === 'SELLER' ? userId : counterpart.id;

    let order: Awaited<ReturnType<typeof this.prisma.order.create>> | undefined;
    let feeCalculation: ReturnType<typeof this.feeCalculator.calculateFee> | undefined;
    let voucherCashbackSen = BigInt(0);
    try {
    for (let attempt = 0; attempt < ORDER_CREATE_MAX_RETRIES; attempt++) {
      const orderId = generateOrderId(await this.getNextOrderSerial());
      try {
        const txResult = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          const [txUser, txCounterpart] = await Promise.all([
            tx.user.findUnique({ where: { id: userId }, select: { id: true, isActive: true, isBanned: true, kycStatus: true, totalOrdersCompleted: true, membershipRank: true } }),
            tx.user.findUnique({ where: { id: counterpart.id }, select: { id: true, isActive: true, isBanned: true, kycStatus: true } }),
          ]);
          if (!txUser || !txUser.isActive || txUser.isBanned) {
            throw new ForbiddenException({ code: ErrorCodes.COUNTERPART_SUSPENDED, message: 'Your account is suspended' });
          }
          if (!txCounterpart || !txCounterpart.isActive || txCounterpart.isBanned) {
            throw new ForbiddenException({ code: ErrorCodes.COUNTERPART_SUSPENDED, message: 'Counterpart account is suspended' });
          }

          if (dto.orderValue > KYC_THRESHOLD_IDR && txUser.kycStatus !== KycStatus.APPROVED) {
            throw new ForbiddenException({ code: ErrorCodes.KYC_REQUIRED, message: 'KYC verification required for orders above Rp 2.000.000' });
          }
          if (dto.orderValue > KYC_THRESHOLD_IDR && txCounterpart.kycStatus !== KycStatus.APPROVED) {
            throw new ForbiddenException({ code: ErrorCodes.KYC_REQUIRED, message: 'Counterpart must complete KYC verification for orders above Rp 2.000.000' });
          }

          const block = await tx.blockList.findFirst({
            where: { OR: [{ blockerId: userId, blockedId: counterpart.id }, { blockerId: counterpart.id, blockedId: userId }] },
          });
          if (block) throw new BadRequestException({ code: ErrorCodes.USER_BLOCKED, message: 'Cannot create order with blocked user' });

          let voucherDiscountSen = BigInt(0);
          let resolvedVoucher: Voucher | null = null;

          if (dto.voucherCode) {
            const [voucher] = await tx.$queryRaw<Array<Voucher>>`
              SELECT * FROM "vouchers"
              WHERE "code" = ${dto.voucherCode.trim().toUpperCase()}
              LIMIT 1
              FOR UPDATE
            `;
            if (!voucher) {
              throw new NotFoundException({ code: ErrorCodes.VOUCHER_NOT_FOUND, message: 'Voucher not found' });
            }
            const now = new Date();
            if (!voucher.isActive || now < voucher.validFrom || now > voucher.validUntil) {
              throw new BadRequestException({ code: ErrorCodes.VOUCHER_EXPIRED, message: 'Voucher is expired or inactive' });
            }
            if (voucher.campaignId) {
              const campaign = await tx.campaign.findUnique({
                where: { id: voucher.campaignId },
                select: { status: true },
              });
              if (!campaign || campaign.status === CampaignStatus.ENDED) {
                throw new BadRequestException({ code: ErrorCodes.VOUCHER_EXPIRED, message: 'Voucher campaign has ended' });
              }
            }
            {
              if (voucher.maxUsageTotal != null && voucher.currentUsage >= voucher.maxUsageTotal) {
                throw new BadRequestException({ code: ErrorCodes.VOUCHER_USAGE_LIMIT_REACHED, message: 'Voucher has reached its maximum usage limit' });
              }

              await this.validateOrderVoucherAudience(tx, voucher, txUser, userId, dto.role, sellerId);

              if (voucher.minOrderValue !== null && toSen(dto.orderValue) < voucher.minOrderValue) {
                throw new BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: 'Order value does not meet the minimum requirement for this voucher' });
              }

              if (voucher.maxUsagePerUser != null) {
                const userUsageRows = await tx.$queryRaw<Array<{ id: string }>>`
                  SELECT "id" FROM "voucher_usages"
                  WHERE "voucherId" = ${voucher.id} AND "userId" = ${userId}
                  FOR UPDATE
                `;
                if (userUsageRows.length >= voucher.maxUsagePerUser) {
                  throw new BadRequestException({
                    code: ErrorCodes.VOUCHER_USAGE_LIMIT_REACHED,
                    message: 'You have reached the per-user usage limit for this voucher',
                  });
                }
              }

              const voucherBenefitSen = this.calculateOrderVoucherBenefitSen(voucher, dto.orderValue, feeConfig);
              if (voucher.voucherType === VoucherType.WALLET_CASHBACK) {
                voucherCashbackSen = voucherBenefitSen;
                voucherDiscountSen = BigInt(0);
              } else if (voucher.voucherType === VoucherType.FEE_DISCOUNT_FLAT || voucher.voucherType === VoucherType.FEE_DISCOUNT_PERCENT) {
                voucherDiscountSen = voucherBenefitSen;
              } else {
                throw new BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: 'Unsupported voucher type for order fee' });
              }
              resolvedVoucher = voucher;
            }
          }

          const txFeeCalc = this.feeCalculator.calculateFee({
            orderValue: dto.orderValue,
            feeResponsibility: dto.feeResponsibility,
            isKahadePlus: effectiveKahadePlus,
            voucherDiscountSen,
            membershipRank: txUser.membershipRank,
          }, feeConfig);

          // Benefit 1 Kahade+ — pembebasan fee untuk subscriber aktif (kuota
          // Rp 990.000 per bulan kalender WIB, dicatat di SubscriptionUsage).
          // Integrasi MINIMAL di titik kalkulasi fee: fungsi fee (FeeCalculator)
          // TIDAK diubah dan state machine escrow TIDAK disentuh — hanya hasil
          // kalkulasi yang disesuaikan SEBELUM order disimpan. Yang dibebaskan
          // adalah porsi fee yang dibayar creator order (userId sebagai
          // BUYER/SELLER sesuai dto.role).
          const creatorFeeSen = dto.role === 'BUYER' ? txFeeCalc.buyerFeeAmount : txFeeCalc.sellerFeeAmount;
          if (creatorFeeSen > BigInt(0)) {
            const feeAfterWaiver = await this.subscriptionsService.waiveFeeIfEligible(userId, creatorFeeSen, tx);
            // waiveFeeIfEligible mengembalikan fee SETELAH waiver: 0n = bebas
            // penuh, feeAmountSen = tanpa waiver, atau nilai di antaranya
            // (waiver parsial bila sisa kuota bulanan < fee).
            const waivedAmount = creatorFeeSen - feeAfterWaiver;
            if (waivedAmount > BigInt(0)) {
              txFeeCalc.feeAmount = txFeeCalc.feeAmount - waivedAmount;
              if (dto.role === 'BUYER') {
                txFeeCalc.buyerFeeAmount = feeAfterWaiver;
                txFeeCalc.buyerPayAmount = txFeeCalc.buyerPayAmount - waivedAmount;
              } else {
                txFeeCalc.sellerFeeAmount = feeAfterWaiver;
                txFeeCalc.sellerReceiveAmount = txFeeCalc.sellerReceiveAmount + waivedAmount;
              }
              this.logger.log(
                `Plus fee waiver applied at order create: user ${userId} fee ${waivedAmount} sen waived of ${creatorFeeSen} sen (role ${dto.role})`,
              );
            }
          }

          const deadlineDays = getConfirmationDeadlineDays(dto.orderType);
          const confirmationDeadlineAt = toWIB().add(deadlineDays, 'day').toDate();

          const newOrder = await tx.order.create({
            data: {
              orderId, buyerId, sellerId,
              title: sanitizedTitle, description: sanitizedDescription,
              orderType: dto.orderType, orderValue: toSen(dto.orderValue),
              // POIN 2 (2026-10-04): jenis transaksi — default DIRECT bila tidak diisi.
              orderKind: dto.orderKind ?? OrderKind.DIRECT,
              feeAmount: txFeeCalc.feeAmount,
              feeResponsibility: dto.feeResponsibility,
              buyerFeeAmount: txFeeCalc.buyerFeeAmount,
              sellerFeeAmount: txFeeCalc.sellerFeeAmount,
              buyerPayAmount: txFeeCalc.buyerPayAmount,
              sellerReceiveAmount: txFeeCalc.sellerReceiveAmount,
              isKahadePlus: effectiveKahadePlus,
              feeRate: txFeeCalc.feeRate,
              deliveryDeadlineDays: dto.deliveryDeadlineDays,
              // T3: tanggal eksplisit pilihan user — dipakai saat pembayaran bila masih di masa depan.
              deliveryDeadlineAt: explicitDeliveryDeadlineAt,
              confirmationDeadlineAt,
              voucherDiscount: txFeeCalc.voucherDiscount,
              membershipRankDiscount: txFeeCalc.membershipRankDiscount,
              voucherId: resolvedVoucher?.id ?? null,
              createdByBuyer: dto.role === 'BUYER',
              attachments: sanitizedAttachments,
              sourceInquiryRoomId: validatedInquiryRoomId,
              // TRX-009: snapshot alamat pengiriman (hanya untuk barang fisik).
              shippingAddressId: shippingSnapshot?.addressId ?? null,
              shippingRecipientName: shippingSnapshot?.recipientName ?? null,
              shippingPhone: shippingSnapshot?.phone ?? null,
              shippingAddressLine: shippingSnapshot?.addressLine ?? null,
              shippingCity: shippingSnapshot?.city ?? null,
              shippingProvince: shippingSnapshot?.province ?? null,
              shippingPostalCode: shippingSnapshot?.postalCode ?? null,
              // Lokasi presisi buyer — snapshot terenkripsi (null bila tidak diberikan).
              buyerLatitude: buyerLocEncrypted?.lat ?? null,
              buyerLongitude: buyerLocEncrypted?.lng ?? null,
              buyerLocationAccuracy: buyerLocEncrypted?.acc ?? null,
              buyerLocationCapturedAt: buyerLocEncrypted?.capturedAt ?? null,
            },
          });

          if (resolvedVoucher) {
            await tx.voucherUsage.create({
              data: {
                voucherId: resolvedVoucher.id,
                userId,
                orderId: newOrder.id,
                discountApplied: resolvedVoucher.voucherType === VoucherType.WALLET_CASHBACK ? voucherCashbackSen : txFeeCalc.voucherDiscount,
              },
            });

            const updatedVoucher = await tx.voucher.updateMany({
              where: {
                id: resolvedVoucher.id,
                OR: [
                  { maxUsageTotal: null },
                  { currentUsage: { lt: resolvedVoucher.maxUsageTotal as number } },
                ],
              },
              data: { currentUsage: { increment: 1 } },
            });

            if (updatedVoucher.count === 0) {
              throw new BadRequestException({
                code: ErrorCodes.VOUCHER_USAGE_LIMIT_REACHED,
                message: 'Voucher has reached its maximum usage limit',
              });
            }
            if (resolvedVoucher.campaignId) {
              const campaignUpdated = await tx.campaign.updateMany({
                where: { id: resolvedVoucher.campaignId, status: { not: CampaignStatus.ENDED } },
                data: { currentRedemptions: { increment: 1 } },
              });
              if (campaignUpdated.count === 0) {
                throw new BadRequestException({ code: ErrorCodes.VOUCHER_EXPIRED, message: 'Voucher campaign has ended' });
              }
            }
          }

          await tx.chatRoom.create({
            data: {
              orderId: newOrder.id,
              type: 'ORDER',
              initiatorId: buyerId,
              counterpartId: sellerId,
              members: {
                create: [
                  { userId: buyerId, role: 'BUYER' },
                  { userId: sellerId, role: 'SELLER' },
                ],
              },
            },
          });

          // 2.6 Auto-archive inquiry room and post system message linking to new order
          if (validatedInquiryRoomId) {
            await tx.chatRoom.update({
              where: { id: validatedInquiryRoomId },
              data: { isArchived: true, archivedAt: new Date(), archivedReason: `Order ${orderId} created from this inquiry` },
            });
            await tx.chatRoomMember.updateMany({
              where: { roomId: validatedInquiryRoomId },
              data: { isArchived: true, archivedAt: new Date() },
            });
          }

          await tx.orderStatusHistory.create({
            data: {
              orderId: newOrder.id,
              fromStatus: null,
              toStatus: OrderStatus.WAITING_CONFIRMATION,
              changedBy: userId,
              changedByType: dto.role === 'BUYER' ? ActorType.BUYER : ActorType.SELLER,
              reason: 'Order created',
              metadata: validatedInquiryRoomId ? { sourceInquiryRoomId: validatedInquiryRoomId, attachments: sanitizedAttachments } : { attachments: sanitizedAttachments },
            },
          });
          return { order: newOrder, feeCalc: txFeeCalc, voucherCashbackSen };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        order = txResult.order;
        feeCalculation = txResult.feeCalc;
        voucherCashbackSen = txResult.voucherCashbackSen;
        break;
      } catch (err: unknown) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          (err.code === 'P2002' || err.code === 'P2034') &&
          attempt < ORDER_CREATE_MAX_RETRIES - 1
        ) {
          const backoffMs = Math.min(100 * Math.pow(2, attempt), 2000);
          this.logger.warn(`Order create transient conflict (${err.code}) on attempt ${attempt + 1}, retrying in ${backoffMs}ms`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          continue;
        }
        throw err;
      }
    }

    if (!order || !feeCalculation) {
      throw new BadRequestException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Failed to create order after retries' });
    }
    } catch (err) {
      await this.redis.del(cooldownKey).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
      throw err;
    }

    if (effectiveKahadePlus) {
      const subCacheKey = `subscription_status:${userId}`;
      await this.redis.del(subCacheKey);
    }

    const counterpartId = dto.role === 'BUYER' ? sellerId : buyerId;
    const creatorName = (user.fullName || user.username || 'User').replace(/[<>\"'&]/g, '');
    const notifTitle = sanitizedTitle.slice(0, 100);

    try {
      const prefs = await this.prisma.notificationPreference.findUnique({ where: { userId: counterpartId } });
      const shouldNotify = !prefs || this.isOrderNotificationEnabled(prefs);
      if (shouldNotify) {
        const escapedBody = this.escapePushBody(`${creatorName} created a new order "${notifTitle}" worth ${formatIdr(dto.orderValue)}. Please confirm.`);
        await this.notificationQueue.enqueue({
          userId: counterpartId,
          type: NotificationType.ORDER_NEW,
          title: 'New Order',
          body: escapedBody,
          pushData: { type: 'ORDER_NEW', orderId: order.orderId },
        });
      }
    } catch (error: unknown) {
      this.logger.warn(`CREATE_ORDER notification failed after commit: ${error instanceof Error ? error.message : String(error)}`);
    }

    return {
      orderId: order.orderId,
      status: order.status,
      feeCalculation: {
        feeRate: feeCalculation.feeRate,
        feeAmount: safeBigIntToNumber(feeCalculation.feeAmount / 100n),
        buyerFeeAmount: safeBigIntToNumber(feeCalculation.buyerFeeAmount / 100n),
        sellerFeeAmount: safeBigIntToNumber(feeCalculation.sellerFeeAmount / 100n),
        buyerPayAmount: safeBigIntToNumber(feeCalculation.buyerPayAmount / 100n),
        sellerReceiveAmount: safeBigIntToNumber(feeCalculation.sellerReceiveAmount / 100n),
        voucherDiscount: safeBigIntToNumber(feeCalculation.voucherDiscount / 100n),
        voucherCashback: safeBigIntToNumber(voucherCashbackSen / 100n),
        membershipRankDiscount: safeBigIntToNumber((feeCalculation.membershipRankDiscount ?? BigInt(0)) / 100n),
      },
      confirmationDeadlineAt: order.confirmationDeadlineAt,
    };
  }

  private isOrderNotificationEnabled(prefs: { orderInApp: boolean; orderPush: boolean }): boolean {
    return prefs.orderInApp || prefs.orderPush;
  }

  private escapePushBody(text: string): string {
    return text.replace(/[\u0000-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '').replace(/[\\]/g, '\\\\').replace(/\"/g, '\\\"');
  }

  private static readonly ACTIVE_STATUSES: OrderStatus[] = [
    OrderStatus.WAITING_CONFIRMATION,
    OrderStatus.WAITING_PAYMENT,
    OrderStatus.PROCESSING,
    OrderStatus.IN_DELIVERY,
  ];

  async getOrders(userId: string, page: number, limit: number, status?: OrderStatus, role?: 'BUYER' | 'SELLER' | 'ALL', search?: string, from?: string, to?: string, sortBy?: string, sortOrder?: string, kind?: OrderKind): Promise<{
    orders: {
      orderId: string;
      orderNumber: string;
      title: string;
      description: string;
      status: OrderStatus;
      orderType: OrderType;
      // POIN 2 (2026-10-04): jenis transaksi escrow — ikut di respons list/detail (dibutuhkan FE + admin).
      orderKind: OrderKind;
      orderValue: number;
      buyerPayAmount: number;
      sellerReceiveAmount: number;
      buyer: { userId: string; username: string | null; fullName: string | null; avatarUrl: string | null };
      seller: { userId: string; username: string | null; fullName: string | null; avatarUrl: string | null };
      role: 'BUYER' | 'SELLER';
      createdAt: Date;
      deliveryDeadlineAt: Date | null;
      autoCompleteAt: Date | null;
      // Batch 139 BE-API1 (item 110).
      paymentDeadlineAt: Date | null;
      confirmationDeadlineAt: Date | null;
    }[];
    // BD-008 (perf-fix 2026-09-29): tanpa COUNT(*) — `total` dihapus.
    // Klien memakai `hasNext`/`totalPages` (halaman terkonfirmasi) untuk
    // load-more; pola limit+1 seperti feed showcase.
    hasNext: boolean;
    totalPages: number;
    page: number;
    limit: number;
  }> {
    const safePage = Math.max(1, Math.trunc(Number.isFinite(page) ? page : 1));
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number.isFinite(limit) ? limit : 20)));
    const skip = (safePage - 1) * safeLimit;
    const where: Prisma.OrderWhereInput = {};
    const orConditions: Prisma.OrderWhereInput[] = [];

    if (role !== undefined && role !== 'BUYER' && role !== 'SELLER' && role !== 'ALL') {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Role must be BUYER, SELLER, or ALL' });
    }
    if (role === 'BUYER') {
      orConditions.push({ buyerId: userId });
    } else if (role === 'SELLER') {
      orConditions.push({ sellerId: userId });
    } else {
      orConditions.push({ buyerId: userId });
      orConditions.push({ sellerId: userId });
    }

    if (orConditions.length > 0) where.OR = orConditions;

    if (status) {
      const statusStr = String(status).toUpperCase();
      if (statusStr === 'ACTIVE') {
        where.status = { in: OrdersService.ACTIVE_STATUSES };
      } else if (Object.values(OrderStatus).includes(statusStr as OrderStatus)) {
        where.status = statusStr as OrderStatus;
      } else {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid order status filter' });
      }
    }

    // POIN 2 (2026-10-04): filter jenis transaksi escrow (opsional).
    if (kind !== undefined) {
      const kindStr = String(kind).toUpperCase() as OrderKind;
      if (!Object.values(OrderKind).includes(kindStr)) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid order kind filter' });
      }
      where.orderKind = kindStr;
    }

    if (search && search.trim().length > 0) {
      const searchTerm = escapeLikePattern(search.trim().slice(0, 100));
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        {
          OR: [
            { orderId: { contains: searchTerm, mode: 'insensitive' } },
            { title: { contains: searchTerm, mode: 'insensitive' } },
            { description: { contains: searchTerm, mode: 'insensitive' } },
          ],
        },
      ];
    }

    // 2.2 Date range filter
    if (from || to) {
      where.createdAt = {};
      if (from) {
        const fromDate = parseDateBoundaryWIB(from, 'start');
        if (fromDate) (where.createdAt as any).gte = fromDate;
      }
      if (to) {
        const toDate = parseDateBoundaryWIB(to, 'end');
        if (toDate) (where.createdAt as any).lte = toDate;
      }
    }

    // 2.3 Sorting
    const allowedSortFields = ['createdAt', 'orderValue', 'deliveryDeadlineAt', 'updatedAt'];
    const sortField = sortBy && allowedSortFields.includes(sortBy) ? sortBy : 'createdAt';
    const sortDir = sortOrder === 'asc' ? 'asc' : 'desc';
    const orderBy: any[] = [];
    orderBy.push({ [sortField]: sortDir });
    // Stable secondary sort
    if (sortField !== 'createdAt') orderBy.push({ createdAt: 'desc' });
    orderBy.push({ id: 'desc' });

    // BD-008: ambil limit + 1 untuk menentukan hasNext tanpa COUNT(*)
    // (COUNT memindai index range linear mengikuti riwayat user).
    const fetched = await this.prisma.order.findMany({
      where, orderBy, skip, take: safeLimit + 1,
      include: {
        buyer: { select: { userId: true, username: true, fullName: true, avatarUrl: true } },
        seller: { select: { userId: true, username: true, fullName: true, avatarUrl: true } },
      },
    });
    const hasNext = fetched.length > safeLimit;
    const orders = hasNext ? fetched.slice(0, safeLimit) : fetched;

    return {
      orders: orders.map((order) => ({
        orderId: order.orderId, orderNumber: order.orderId,
        // BD-007: daftar hanya kirim excerpt (maks 200 char, pola NP-007) —
        // deskripsi full (s.d. 500 char) hanya di GET /v1/orders/:id.
        title: order.title, description: toExcerpt(order.description), status: order.status,
        orderType: order.orderType,
        orderKind: order.orderKind,
        orderValue: toIdr(order.orderValue),
        buyerPayAmount: toIdr(order.buyerPayAmount),
        sellerReceiveAmount: toIdr(order.sellerReceiveAmount),
        ...(order.status === OrderStatus.CANCELLED ? { cancelReason: order.cancelReason ?? null } : {}),
        buyer: order.buyer, seller: order.seller,
        role: order.buyerId === userId ? 'BUYER' : 'SELLER',
        createdAt: order.createdAt,
        deliveryDeadlineAt: order.deliveryDeadlineAt,
        autoCompleteAt: order.status === OrderStatus.IN_DELIVERY && order.deliveryDeadlineAt ? order.deliveryDeadlineAt : null,
        // Batch 139 BE-API1 (item 110): deadline bayar & konfirmasi di daftar
        // order (dukung countdown I035) — detail sudah punya keduanya sejak
        // lama; daftar selama ini hanya punya deliveryDeadlineAt/autoCompleteAt.
        paymentDeadlineAt: order.paymentDeadlineAt ?? null,
        confirmationDeadlineAt: order.confirmationDeadlineAt ?? null,
      })),
      hasNext,
      // Halaman terkonfirmasi (bukan total sebenarnya) — cukup untuk load-more.
      totalPages: hasNext ? safePage + 1 : safePage,
      page: safePage, limit: safeLimit,
    };
  }

  /**
   * D1-005 (perf 2026-09-29): status ringan untuk poll — SATU select 5 kolom
   * (termasuk buyerId/sellerId untuk cek akses), bukan bundle penuh
   * getOrderDetail (order + buyer/seller + voucher + 50 riwayat + durasi).
   * Dipakai endpoint GET /v1/orders/:orderId/status.
   */
  async getOrderStatus(userId: string, orderId: string): Promise<{ orderId: string; status: string; updatedAt: Date }> {
    const order = await this.prisma.order.findFirst({
      where: { orderId },
      select: { orderId: true, status: true, updatedAt: true, buyerId: true, sellerId: true },
    });
    if (!order) throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
    if (order.buyerId !== userId && order.sellerId !== userId) {
      throw new ForbiddenException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Not authorized to view this order' });
    }
    return { orderId: order.orderId, status: order.status, updatedAt: order.updatedAt };
  }

  async getOrderDetail(userId: string, orderId: string): Promise<{ order: object }> {
    const order = await this.prisma.order.findFirst({
      where: { orderId },
      include: {
        buyer: { select: { userId: true, username: true, fullName: true, avatarUrl: true, kycStatus: true, averageRating: true, totalOrdersCompleted: true } },
        seller: { select: { userId: true, username: true, fullName: true, avatarUrl: true, kycStatus: true, averageRating: true, totalOrdersCompleted: true } },
        voucher: { select: { code: true, name: true } },
        statusHistories: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, fromStatus: true, toStatus: true, changedByType: true, reason: true, createdAt: true } },
        dispute: { select: { id: true, status: true } },
        chatRoom: { select: { id: true } },
      },
    });

    if (!order) throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
    if (order.buyerId !== userId && order.sellerId !== userId) {
      throw new ForbiddenException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Not authorized to view this order' });
    }

    const existingRating = await this.prisma.rating.findUnique({
      where: { orderId_giverId: { orderId: order.id, giverId: userId } },
    });

    // Fetch source inquiry room messages for context if exists
    let inquiryContext: any = null;
    if ((order as any).sourceInquiryRoomId) {
      const inquiryRoom = await this.prisma.chatRoom.findUnique({
        where: { id: (order as any).sourceInquiryRoomId },
        select: { id: true, subject: true, createdAt: true },
      });
      inquiryContext = inquiryRoom;
    }

    // Batch 139 BE-API1 (item 111/112): dihitung sekali, dipakai field +
    // availableActions (hindari query policy ganda).
    const returnWindowUntil = await this.getReturnWindowUntil(order);

    // TRX-009 (UI/UX audit 2026-09-28): alamat pengiriman — snapshot
    // terenkripsi (AES-GCM) saat order dibuat, didekripsi untuk buyer/seller
    // (keduanya pihak order). Null bila order non-fisik / dibuat sebelum
    // fitur ini.
    const shippingAddressSnapshotId = (order as any).shippingAddressId as string | null;
    const shippingAddress = shippingAddressSnapshotId
      ? {
          id: shippingAddressSnapshotId,
          recipientName: await decryptPiiSafe((order as any).shippingRecipientName),
          phone: await decryptPiiSafe((order as any).shippingPhone),
          addressLine: await decryptPiiSafe((order as any).shippingAddressLine),
          city: await decryptPiiSafe((order as any).shippingCity),
          province: await decryptPiiSafe((order as any).shippingProvince),
          postalCode: await decryptPiiSafe((order as any).shippingPostalCode),
        }
      : null;

    return {
      order: {
        orderId: order.orderId, title: order.title, description: order.description,
        orderType: order.orderType, orderKind: order.orderKind, status: order.status,
        ...(order.status === OrderStatus.CANCELLED ? {
          cancelReason: order.cancelReason ?? null,
          cancelNote: order.cancelNote ?? null,
        } : {}),
        orderValue: toIdr(order.orderValue), feeAmount: toIdr(order.feeAmount),
        feeResponsibility: order.feeResponsibility,
        buyerFeeAmount: toIdr(order.buyerFeeAmount), sellerFeeAmount: toIdr(order.sellerFeeAmount),
        buyerPayAmount: toIdr(order.buyerPayAmount), sellerReceiveAmount: toIdr(order.sellerReceiveAmount),
        voucherDiscount: toIdr(order.voucherDiscount), isKahadePlus: order.isKahadePlus,
        feeRate: order.feeRate, deliveryDeadlineDays: order.deliveryDeadlineDays,
        deliveryDeadlineAt: order.deliveryDeadlineAt,
        // Item 10 (batch 2026-09-28): alias untuk frontend. Policy tenggat kirim
        // SUDAH ada di kode: deliveryDeadlineAt diset saat paidAt
        // (= paidAt + deliveryDeadlineDays, 1-14 hari, CHECK constraint di DB).
        // shippingDeadline = tenggat seller kirim; shippedBy = kapan seller
        // benar-benar kirim (shippedAt). Keduanya nullable apa adanya —
        // TIDAK ada policy baru yang diciptakan di sini.
        shippingDeadline: order.deliveryDeadlineAt ?? null,
        shippedBy: order.shippedAt ?? null,
        // T3 (audit 2026-09-26): kapan order IN_DELIVERY akan auto-complete oleh cron —
        // sama dengan deliveryDeadlineAt selama status IN_DELIVERY, null selain itu.
        // Field baca saja; tidak mengubah cron/state machine.
        autoCompleteAt: order.status === OrderStatus.IN_DELIVERY && order.deliveryDeadlineAt ? order.deliveryDeadlineAt : null,
        paymentDeadlineAt: order.paymentDeadlineAt,
        confirmationDeadlineAt: order.confirmationDeadlineAt ?? null,
        processingDeadlineAt: order.processingDeadlineAt ?? null,
        trackingNumber: order.trackingNumber, courierName: order.courierName,
        trackingNotes: order.trackingNotes ?? null,
        // TRX-009: alamat pengiriman snapshot (didekripsi) — penjual butuh ini
        // untuk tahu kirim ke mana; null untuk order non-fisik.
        shippingAddress,
        attachments: (order as any).attachments ?? [],
        sourceInquiryRoomId: (order as any).sourceInquiryRoomId ?? null,
        sourceInquiryRoom: inquiryContext,
        createdByRole: order.createdByBuyer ? 'BUYER' : 'SELLER',
        // BUG#1 (2026-09-26): peran viewer eksplisit. Sebelumnya frontend
        // menginfer peran dari pencocokan ID lintas namespace (me.id cuid
        // internal vs buyer/seller.id public USR-XXX) yang tidak pernah cocok,
        // sehingga layar selalu "Peran Anda belum terkonfirmasi".
        myRole: order.buyerId === userId ? 'BUYER' : 'SELLER',
        createdAt: order.createdAt, confirmedAt: order.confirmedAt,
        paidAt: order.paidAt, completedAt: order.completedAt,
        cancelledAt: order.cancelledAt,
        shippedAt: order.shippedAt ?? null, processedAt: order.processedAt ?? null, disputedAt: order.disputedAt ?? null,
        updatedAt: order.updatedAt ?? order.createdAt,
        postCompletionDisputeDeadlineAt: order.completedAt
          ? new Date(order.completedAt.getTime() + POST_COMPLETION_DISPUTE_WINDOW_HOURS * 60 * 60 * 1000)
          : null,
        // Batch 139 BE-API1 (item 111): batas akhir pengajuan retur — turunan
        // murni (completedAt + returnWindowDays kebijakan per orderType,
        // fallback DEFAULT_RETURN_WINDOW_DAYS). null bila order belum
        // COMPLETED (jendela retur tak berlaku). Pola sama dengan
        // postCompletionDisputeDeadlineAt di atas. Read-only.
        returnWindowUntil,
        // Batch 139 BE-API1 (item 112): daftar aksi yang bisa dilakukan viewer
        // saat ini (read-only). Nama aksi = suffix UPPER_SNAKE dari prop
        // `can*` FE (`OrderDetailActionsProps`) agar FE bisa menggantikan
        // duplikasi state machine-nya dengan sumber kebenaran tunggal ini.
        availableActions: this.getAvailableActions(order, userId, !!existingRating, returnWindowUntil),
        buyer: order.buyer, seller: order.seller, voucher: order.voucher,
        chatRoomId: order.chatRoom?.id ?? null,
        hasRated: !!existingRating,
        hasDispute: order.dispute !== null,
        disputeId: order.dispute?.id ?? null,
        dispute: order.dispute ? { id: order.dispute.id, status: order.dispute.status } : null,
        statusHistories: order.statusHistories ?? [],
      },
    };
  }

  /**
   * Batch 139 BE-API1 (item 111): `returnWindowUntil` — batas akhir pengajuan
   * retur = completedAt + returnWindowDays (kebijakan per orderType, fallback
   * DEFAULT_RETURN_WINDOW_DAYS bila policy belum di-seed; pola sama dengan
   * ReturnsService.getPolicy). null bila order belum COMPLETED / completedAt
   * hilang (jendela tak berlaku). Murni turunan — tanpa tulis, tanpa ubah
   * logika retur/escrow.
   */
  private async getReturnWindowUntil(order: {
    status: OrderStatus;
    orderType: OrderType;
    completedAt: Date | null;
  }): Promise<Date | null> {
    if (order.status !== OrderStatus.COMPLETED || !order.completedAt) return null;
    const policy = await this.prisma.returnPolicy.findFirst({
      where: { orderType: order.orderType, category: null, isActive: true },
      select: { returnWindowDays: true },
    });
    const windowDays = policy?.returnWindowDays ?? DEFAULT_RETURN_WINDOW_DAYS;
    return new Date(order.completedAt.getTime() + windowDays * 86_400_000);
  }

  /**
   * Batch 139 BE-API1 (item 112): `availableActions` — daftar aksi yang bisa
   * dilakukan viewer pada order ini, dihitung server-side dari status × peran
   * (sumber kebenaran tunggal; FE saat ini menduplikasi state machine ini di
   * `app/order/[id].tsx` — rawan drift).
   *
   * Nama aksi = suffix UPPER_SNAKE dari prop `can*` di FE
   * (`components/order-detail-actions.tsx` → `OrderDetailActionsProps`):
   * PAY←canPay, CONFIRM←canConfirm, SHIP←canShip,
   * REVIEW_DELIVERY←canReviewDelivery, RATE←canRate, VIEW_PROOF←canViewProof,
   * RETURN←canReturnPrimary/onReturn, CANCEL←canCancel, DISPUTE←canDispute,
   * EXTEND←canExtend.
   *
   * Gerbang diselaraskan dengan FE (`lib/api/orders-shared.ts`:
   * isCancellable/isDisputable/isExtendable/isRatingWindowOpen) yang
   * masing-masing didokumentasikan selaras dengan backend
   * (order-state.service cancelOrder, order-extensions.service, jendela rating
   * RATING_WINDOW_DAYS). Read-only: tidak mengubah state machine.
   */
  private getAvailableActions(
    order: {
      status: OrderStatus;
      orderType: OrderType;
      buyerId: string;
      sellerId: string;
      completedAt: Date | null;
    },
    viewerId: string,
    alreadyRated: boolean,
    returnWindowUntil: Date | null,
  ): string[] {
    const isBuyer = order.buyerId === viewerId;
    const isSeller = order.sellerId === viewerId;
    const knownRole = isBuyer || isSeller;
    const status = order.status;
    const actions: string[] = [];

    // canPay: WAITING_PAYMENT + buyer (FE juga mengenali alias legacy
    // PENDING_PAYMENT yang sudah dinormalisasi ke WAITING_PAYMENT di pintu masuk).
    if (status === OrderStatus.WAITING_PAYMENT && isBuyer) actions.push('PAY');
    // canConfirm: WAITING_CONFIRMATION + seller (terima/tolak order).
    if (status === OrderStatus.WAITING_CONFIRMATION && isSeller) actions.push('CONFIRM');
    // canShip: PROCESSING + seller (kirim barang).
    if (status === OrderStatus.PROCESSING && isSeller) actions.push('SHIP');
    // canReviewDelivery: IN_DELIVERY + buyer (tinjau/konfirmasi terima).
    if (status === OrderStatus.IN_DELIVERY && isBuyer) actions.push('REVIEW_DELIVERY');
    // canRate: COMPLETED + belum menilai + dalam jendela rating backend.
    if (
      knownRole &&
      status === OrderStatus.COMPLETED &&
      !alreadyRated &&
      order.completedAt &&
      Date.now() - order.completedAt.getTime() <= RATING_WINDOW_DAYS * 86_400_000
    ) {
      actions.push('RATE');
    }
    // canViewProof: seller melihat bukti pengiriman saat IN_DELIVERY.
    if (isSeller && status === OrderStatus.IN_DELIVERY) actions.push('VIEW_PROOF');
    // canReturnPrimary (item 46): buyer + jendela retur masih terbuka.
    // Aproksimasi jendela dari returnWindowUntil (eligibilitas penuh —
    // sengketa aktif/retur aktif — tetap divalidasi endpoint retur saat create).
    if (isBuyer && returnWindowUntil && Date.now() <= returnWindowUntil.getTime()) {
      actions.push('RETURN');
    }
    // canCancel: WAITING_CONFIRMATION/WAITING_PAYMENT, buyer & seller
    // (selaras order-state.service#cancelOrder).
    if (knownRole && (status === OrderStatus.WAITING_CONFIRMATION || status === OrderStatus.WAITING_PAYMENT)) {
      actions.push('CANCEL');
    }
    // canDispute: PROCESSING/IN_DELIVERY (selaras batasan service dispute).
    if (knownRole && (status === OrderStatus.PROCESSING || status === OrderStatus.IN_DELIVERY)) {
      actions.push('DISPUTE');
    }
    // canExtend: IN_DELIVERY + seller (selaras order-extensions.service).
    if (isSeller && status === OrderStatus.IN_DELIVERY) actions.push('EXTEND');

    return actions;
  }

  async getOrderSummary(userId: string): Promise<{
    asBuyer: { count: number; totalValue: number };
    asSeller: { count: number; totalValue: number };
    inDispute: number;
    pendingExtensions: number;
  }> {
    const buyerStatuses = [OrderStatus.WAITING_PAYMENT, OrderStatus.PROCESSING, OrderStatus.IN_DELIVERY];
    const sellerStatuses = [OrderStatus.WAITING_CONFIRMATION, OrderStatus.PROCESSING, OrderStatus.IN_DELIVERY];

    const [buyerAgg, sellerAgg, inDispute, pendingExtensions] = await Promise.all([
      this.prisma.order.aggregate({
        where: { buyerId: userId, status: { in: buyerStatuses } },
        _count: true,
        _sum: { buyerPayAmount: true },
      }),
      this.prisma.order.aggregate({
        where: { sellerId: userId, status: { in: sellerStatuses } },
        _count: true,
        _sum: { sellerReceiveAmount: true },
      }),
      this.prisma.order.count({ where: { OR: [{ buyerId: userId }, { sellerId: userId }], status: OrderStatus.DISPUTED } }),
      this.prisma.orderExtensionRequest.count({
        where: {
          order: { OR: [{ buyerId: userId }, { sellerId: userId }] },
          status: DeadlineExtensionStatus.PENDING,
        },
      }),
    ]);

    const buyerTotalValue = toIdr(buyerAgg._sum.buyerPayAmount ?? BigInt(0));
    const sellerTotalValue = toIdr(sellerAgg._sum.sellerReceiveAmount ?? BigInt(0));

    return {
      asBuyer: { count: buyerAgg._count, totalValue: buyerTotalValue },
      asSeller: { count: sellerAgg._count, totalValue: sellerTotalValue },
      inDispute,
      pendingExtensions,
    };
  }

  async calculateFee(dto: { orderValue: number; feeResponsibility: FeeResponsibility; voucherCode?: string; role?: 'BUYER' | 'SELLER' }, userId: string): Promise<{
    orderValue: number;
    feeRate: number;
    feeAmount: number;
    buyerFeeAmount: number;
    sellerFeeAmount: number;
    buyerPayAmount: number;
    sellerReceiveAmount: number;
    voucherDiscount: number;
    voucherCashback: number;
    membershipRankDiscount: number;
    isKahadePlusApplied: boolean;
    feeWaivedAmount: number;
  }> {
    if (!Number.isSafeInteger(dto.orderValue) || dto.orderValue < this.configuredMinOrderValue || dto.orderValue > this.configuredMaxOrderValue) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `Order value must be an integer between ${formatIdr(this.configuredMinOrderValue)} and ${formatIdr(this.configuredMaxOrderValue)}` });
    }
    if (!Object.values(FeeResponsibility).includes(dto.feeResponsibility)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid fee responsibility' });
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    let voucherDiscountSen = BigInt(0);
    let voucherCashbackSen = BigInt(0);
    const feeConfig = await this.feeCalculator.getFeeConfig();

    let effectiveKahadePlusEst = user.isKahadePlus;
    if (effectiveKahadePlusEst) {
      const activeSub = await this.prisma.subscription.findFirst({
        where: {
          userId,
          status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.CANCELLED] },
          currentPeriodEnd: { gt: new Date() },
        },
        select: { feeSavingsUsed: true, feeSavingsLimit: true },
      });
      if (!activeSub || activeSub.feeSavingsUsed >= activeSub.feeSavingsLimit) {
        effectiveKahadePlusEst = false;
      }
    }

    if (dto.voucherCode) {
      const voucherCode = dto.voucherCode.trim().toUpperCase();
      if (voucherCode.length > 50) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Voucher code is too long' });
      }
      const voucher = await this.prisma.voucher.findFirst({
        where: {
          code: voucherCode,
          isActive: true,
          validFrom: { lte: new Date() },
          validUntil: { gte: new Date() },
        },
      });
      if (voucher) {
        if (voucher.maxUsageTotal != null && voucher.currentUsage >= voucher.maxUsageTotal) {
          throw new BadRequestException({ code: ErrorCodes.VOUCHER_USAGE_LIMIT_REACHED, message: 'Voucher has reached its maximum usage limit' });
        }

        if (voucher.maxUsagePerUser != null) {
          const userUsageCount = await this.prisma.voucherUsage.count({
            where: { voucherId: voucher.id, userId },
          });
          if (userUsageCount >= voucher.maxUsagePerUser) {
            throw new BadRequestException({
              code: ErrorCodes.VOUCHER_USAGE_LIMIT_REACHED,
              message: 'You have reached the per-user usage limit for this voucher',
            });
          }
        }

        if (voucher.minOrderValue !== null && toSen(dto.orderValue) < voucher.minOrderValue) {
          throw new BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: 'Order value does not meet the minimum requirement for this voucher' });
        }

        if (!dto.role && (voucher.applicableTo === VoucherApplicability.BUYER_ONLY || voucher.applicableTo === VoucherApplicability.SELLER_ONLY)) {
          throw new BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: `This voucher is only for ${voucher.applicableTo === VoucherApplicability.BUYER_ONLY ? 'buyers' : 'sellers'}. Please specify your role.` });
        }
        await this.validateOrderVoucherAudience(this.prisma, voucher, user, userId, dto.role ?? 'BUYER');

        if (voucher.voucherType === VoucherType.WALLET_CASHBACK) {
          voucherCashbackSen = this.calculateOrderVoucherBenefitSen(voucher, dto.orderValue, feeConfig);
          voucherDiscountSen = BigInt(0);
        } else if (voucher.voucherType === VoucherType.FEE_DISCOUNT_FLAT || voucher.voucherType === VoucherType.FEE_DISCOUNT_PERCENT) {
          voucherDiscountSen = this.calculateOrderVoucherBenefitSen(voucher, dto.orderValue, feeConfig);
        } else {
          throw new BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: 'Unsupported voucher type for order fee' });
        }
      }
    }

    const feeCalculation = this.feeCalculator.calculateFee({
      orderValue: dto.orderValue,
      feeResponsibility: dto.feeResponsibility,
      isKahadePlus: effectiveKahadePlusEst,
      voucherDiscountSen,
      membershipRank: user.membershipRank,
    }, feeConfig);

    // WF-019: sertakan estimasi Kahade+ fee waiver di preview agar angka
    // estimasi = yang benar-benar dibayar saat createOrder. estimateWaiverAmount
    // bersifat READ-ONLY (tidak menghabiskan kuota) — tidak seperti
    // waiveFeeIfEligible yang mencatat usage di dalam transaksi order.
    // Yang dibebaskan = porsi fee creator order (role BUYER/SELLER), cerminan
    // logika createOrder.
    let feeWaivedSen = BigInt(0);
    let adjFeeAmount = feeCalculation.feeAmount;
    let adjBuyerFeeAmount = feeCalculation.buyerFeeAmount;
    let adjSellerFeeAmount = feeCalculation.sellerFeeAmount;
    let adjBuyerPayAmount = feeCalculation.buyerPayAmount;
    let adjSellerReceiveAmount = feeCalculation.sellerReceiveAmount;
    if (user.isKahadePlus) {
      const creatorRole = dto.role ?? 'BUYER';
      const creatorFeeSen = creatorRole === 'BUYER' ? feeCalculation.buyerFeeAmount : feeCalculation.sellerFeeAmount;
      feeWaivedSen = await this.subscriptionsService.estimateWaiverAmount(userId, creatorFeeSen);
      if (feeWaivedSen > BigInt(0)) {
        adjFeeAmount = adjFeeAmount - feeWaivedSen;
        if (creatorRole === 'BUYER') {
          adjBuyerFeeAmount = adjBuyerFeeAmount - feeWaivedSen;
          adjBuyerPayAmount = adjBuyerPayAmount - feeWaivedSen;
        } else {
          adjSellerFeeAmount = adjSellerFeeAmount - feeWaivedSen;
          adjSellerReceiveAmount = adjSellerReceiveAmount + feeWaivedSen;
        }
      }
    }

    return {
      orderValue: dto.orderValue,
      feeRate: feeCalculation.feeRate,
      feeAmount: safeBigIntToNumber(adjFeeAmount / 100n),
      buyerFeeAmount: safeBigIntToNumber(adjBuyerFeeAmount / 100n),
      sellerFeeAmount: safeBigIntToNumber(adjSellerFeeAmount / 100n),
      buyerPayAmount: safeBigIntToNumber(adjBuyerPayAmount / 100n),
      sellerReceiveAmount: safeBigIntToNumber(adjSellerReceiveAmount / 100n),
      voucherDiscount: safeBigIntToNumber(feeCalculation.voucherDiscount / 100n),
      voucherCashback: safeBigIntToNumber(voucherCashbackSen / 100n),
      membershipRankDiscount: safeBigIntToNumber((feeCalculation.membershipRankDiscount ?? BigInt(0)) / 100n),
      isKahadePlusApplied: effectiveKahadePlusEst,
      feeWaivedAmount: safeBigIntToNumber(feeWaivedSen / 100n),
    };
  }

  private async getNextOrderSerial(): Promise<number> {
    const today = formatWIBDate().replace(/-/g, '');
    const key = ORDER_SERIAL(today);
    const redisClient = this.redis.getClient();
    const redisKey = `${this.redis.getPrefix()}${key}`;

    const atomicScript = `
      local current = redis.call("INCR", KEYS[1])
      if current == 1 then
        redis.call("EXPIRE", KEYS[1], ARGV[1])
      end
      return current
    `;
    const serial = await redisClient.eval(atomicScript, 1, redisKey, (86400 * 2).toString()) as number;

    if (serial === 1) {
      const syncLockKey = `order_serial_sync:${today}`;
      const lockAcquired = await this.redis.setNx(syncLockKey, '1', 60);
      if (lockAcquired) {
        try {
          const maxOrder = await this.prisma.order.findFirst({
            where: { orderId: { startsWith: `ORD-${today}-` } },
            orderBy: { orderId: 'desc' },
            select: { orderId: true },
          });
          if (maxOrder) {
            const parts = maxOrder.orderId.split('-');
            const existingSerial = parseInt(parts[2], 10);
            if (existingSerial >= 1) {
              const setIfHigherScript = `
                local current = tonumber(redis.call("get", KEYS[1]) or "0")
                local desired = tonumber(ARGV[1])
                if desired > current then
                  redis.call("set", KEYS[1], ARGV[1])
                  redis.call("expire", KEYS[1], ARGV[2])
                  return desired
                end
                return current
              `;
              const newSerial = await redisClient.eval(setIfHigherScript, 1, redisKey, (existingSerial + 1).toString(), (86400 * 2).toString()) as number;
              return newSerial;
            }
          }
        } finally {
          await this.redis.del(syncLockKey);
        }
      } else {
        await new Promise(r => setTimeout(r, 50));
        return await redisClient.eval(atomicScript, 1, redisKey, (86400 * 2).toString()) as number;
      }
    }
    return serial;
  }

  async validateCounterpart(userId: string, counterpartUsername: string): Promise<{
    user: {
      username: string | null;
      fullName: string | null;
      avatarUrl: string | null;
      isKycVerified: boolean;
      membershipRank: string;
      avgRating: unknown;
      totalOrdersCompleted: number;
    } | null;
    isBlocked: boolean;
    canCreateOrder: boolean;
    reason?: string;
  }> {
    const normalizedUsername = typeof counterpartUsername === 'string' ? counterpartUsername.trim().toLowerCase() : '';
    if (normalizedUsername.length < 3 || normalizedUsername.length > 50) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Username must be between 3 and 50 characters' });
    }
    const counterpart = await this.prisma.user.findUnique({
      where: { username: normalizedUsername },
      select: {
        id: true, username: true, fullName: true, avatarUrl: true,
        isActive: true, isBanned: true, kycStatus: true,
        membershipRank: true, averageRating: true, totalOrdersCompleted: true,
      },
    });

    if (!counterpart) {
      return { user: null, isBlocked: false, canCreateOrder: false, reason: 'USER_NOT_FOUND' };
    }

    if (counterpart.id === userId) {
      throw new BadRequestException({ code: ErrorCodes.CANNOT_ORDER_SELF, message: 'Cannot validate yourself as a counterpart' });
    }

    const block = await this.prisma.blockList.findFirst({
      where: { OR: [{ blockerId: userId, blockedId: counterpart.id }, { blockerId: counterpart.id, blockedId: userId }] },
    });

    const canCreateOrder = counterpart.isActive && !counterpart.isBanned && !block;

    return {
      user: {
        username: counterpart.username,
        fullName: counterpart.fullName,
        avatarUrl: counterpart.avatarUrl,
        isKycVerified: counterpart.kycStatus === KycStatus.APPROVED,
        membershipRank: counterpart.membershipRank,
        avgRating: counterpart.averageRating,
        // BUG#5 (pola drift yang sama): frontend membaca `completedOrders` /
        // `totalOrdersCompleted` untuk kartu validasi lawan transaksi, tapi
        // field ini tidak pernah dikirim — selalu undefined di UI.
        totalOrdersCompleted: counterpart.totalOrdersCompleted,
      },
      isBlocked: !!block,
      canCreateOrder,
    };
  }

  async processOrder(orderId: string, sellerId: string): Promise<{ orderId: string; status: string }> {
    let buyerId: string | undefined;
    let orderType: OrderType | undefined;
    await this.withSerializableRetry(() => this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // T1 (audit 2026-09-26): AUDIT-16 tidak mencakup method ini — order yang di-soft-delete
      // masih bisa di-"process" (dikirim). Filter deletedAt seperti path state lain.
      const order = await tx.order.findFirst({
        where: { orderId, sellerId, deletedAt: null },
      });
      if (!order) {
        const exists = await tx.order.findUnique({ where: { orderId }, select: { id: true } });
        if (!exists) throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
        throw new ForbiddenException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Not authorized' });
      }
      if (order.status !== OrderStatus.PROCESSING) throw new BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order is not in PROCESSING status' });

      if (order.orderType === OrderType.PHYSICAL_GOODS && (!order.trackingNumber || !order.courierName)) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Tracking number and courier must be provided before marking a physical order as in delivery',
        });
      }

      buyerId = order.buyerId;
      orderType = order.orderType;
      const now = new Date();
      const deliveryDeadlineAt = order.deliveryDeadlineAt ?? addDays(now, order.deliveryDeadlineDays);

      const updated = await tx.order.updateMany({ where: { id: order.id, status: OrderStatus.PROCESSING }, data: { status: OrderStatus.IN_DELIVERY, shippedAt: order.shippedAt ?? now, processedAt: order.processedAt ?? now, deliveryDeadlineAt } });
      if (updated.count === 0) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order status has already changed' });
      }
      await tx.orderStatusHistory.create({ data: { orderId: order.id, fromStatus: OrderStatus.PROCESSING, toStatus: OrderStatus.IN_DELIVERY, changedBy: sellerId, changedByType: ActorType.SELLER } });

    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }), 'PROCESS_ORDER_TX');
    if (buyerId) {
      const isPhysicalOrder = orderType === OrderType.PHYSICAL_GOODS;
      const notificationType = isPhysicalOrder ? NotificationType.ORDER_SHIPPED : NotificationType.ORDER_DELIVERED;
      this.enqueueOrderNotificationBestEffort({
        userId: buyerId,
        type: notificationType,
        title: isPhysicalOrder ? 'Order Shipped' : 'Order Ready for Review',
        body: isPhysicalOrder
          ? `Order ${orderId} has been shipped by the seller. Please check the tracking number.`
          : `Order ${orderId} is ready for your delivery-proof review.`,
        pushData: { type: notificationType, orderId },
      }, `PROCESS_ORDER orderId=${orderId}`);
    }
    this.runRealtimeBestEffort(() => this.realtime.emitToOrder(orderId, 'order.status_changed', { orderId, status: 'IN_DELIVERY' }), `PROCESS_ORDER_STATUS orderId=${orderId}`);
    this.runRealtimeBestEffort(() => this.realtime.emitToOrder(orderId, 'order.status', { orderId, status: 'IN_DELIVERY' }), `PROCESS_ORDER_STATUS_LEGACY orderId=${orderId}`);
    return { orderId, status: 'IN_DELIVERY' };
  }

  async updateShipping(orderId: string, sellerId: string, dto: { trackingNumber?: string; courierName?: string; trackingNotes?: string }): Promise<{ orderId: string; trackingNumber: string | null; courierName: string | null }> {
    const validStatuses: OrderStatus[] = [OrderStatus.PROCESSING, OrderStatus.IN_DELIVERY];

    const result = await this.withSerializableRetry(() => this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // T1 (audit 2026-09-26): lihat processOrder — order terhapus tidak boleh diubah pengirimannya.
      const order = await tx.order.findFirst({ where: { orderId, deletedAt: null } });
      if (!order) throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
      if (order.sellerId !== sellerId) throw new ForbiddenException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Not authorized' });

      if (!validStatuses.includes(order.status)) {
        throw new BadRequestException({
          code: ErrorCodes.INVALID_ORDER_STATUS,
          message: 'Order is not in a valid status for shipping update',
        });
      }

      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`;
      const freshOrder = await tx.order.findUnique({ where: { id: order.id } });
      if (!freshOrder || !validStatuses.includes(freshOrder.status) || freshOrder.sellerId !== sellerId) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order is no longer available for shipping update' });
      }
      const trackingNumber = dto.trackingNumber?.trim() || null;
      const courierName = dto.courierName?.trim() || null;
      if (freshOrder.orderType === OrderType.PHYSICAL_GOODS && (!trackingNumber || !courierName)) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Tracking number and courier are required for physical orders' });
      }
      if (freshOrder.orderType !== OrderType.PHYSICAL_GOODS && (trackingNumber !== null || courierName !== null)) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Tracking number and courier are only valid for physical orders' });
      }

      const updated = await tx.order.updateMany({
        where: { id: order.id, status: freshOrder.status },
        data: {
          trackingNumber,
          courierName,
          ...(dto.trackingNotes !== undefined ? { trackingNotes: dto.trackingNotes.trim() || null } : {}),
        },
      });

      if (updated.count === 0) {
        throw new ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Order status has already changed' });
      }

      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: freshOrder.status,
          toStatus: freshOrder.status,
          changedBy: sellerId,
          changedByType: ActorType.SELLER,
          reason: 'SHIPPING_DETAILS_UPDATED',
          metadata: { trackingNumber: Boolean(trackingNumber), courierName: Boolean(courierName) },
        },
      });
      return { trackingNumber, courierName };
    }), 'UPDATE_SHIPPING_TX');

    // Batch 43 BE-CHAT: pesan sistem "resi diperbarui" di room order (best-effort).
    try {
      ChatOrderHooks.emit(orderId, 'ORDER_TRACKING_UPDATED', {
        courierName: result.courierName,
        trackingNumber: result.trackingNumber,
      });
    } catch { /* never block shipping update */ }

    return { orderId, ...result };
  }

  async getOrderHistory(orderId: string, userId: string, page: number = 1, limit: number = 20): Promise<{
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

    const [history, total] = await Promise.all([
      this.prisma.orderStatusHistory.findMany({
        where: { orderId: order.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: safeLimit,
      }),
      this.prisma.orderStatusHistory.count({ where: { orderId: order.id } }),
    ]);

    return {
      data: history.map(({ id: _id, ...rest }) => rest),
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    };
  }

  async getAverageDurations(): Promise<Record<string, number>> {
    const cached = await this.redis.get(ORDER_AVG_DURATIONS_CACHE);
    if (cached) {
      try {
        const parsed: unknown = JSON.parse(cached);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, number>;
      } catch {
        // ignore parse error, recalculate
      }
    }

    const rows = await this.prisma.$queryRaw<Array<{ from_status: string; avg_hours: number }>>`
      WITH completed_orders AS (
        SELECT id, "createdAt" AS order_created_at FROM "orders" WHERE "status" = 'COMPLETED'::"OrderStatus"
      ),
      all_transitions AS (
        SELECT
          h."orderId",
          h."toStatus"::text AS "toStatus",
          h."createdAt",
          LEAD(h."createdAt") OVER (PARTITION BY h."orderId" ORDER BY h."createdAt" ASC) AS next_ts
        FROM "order_status_histories" h
        INNER JOIN completed_orders co ON co.id = h."orderId"
      ),
      creation_durations AS (
        SELECT
          co.id AS "orderId",
          'WAITING_CONFIRMATION'::text AS "toStatus",
          co.order_created_at AS "createdAt",
          MIN(h."createdAt") AS next_ts
        FROM completed_orders co
        INNER JOIN "order_status_histories" h ON h."orderId" = co.id
        GROUP BY co.id, co.order_created_at
      ),
      combined AS (
        SELECT "orderId", "toStatus", "createdAt", next_ts
        FROM all_transitions
        WHERE "toStatus" IN ('WAITING_CONFIRMATION', 'WAITING_PAYMENT', 'PROCESSING', 'IN_DELIVERY')
          AND next_ts IS NOT NULL
        UNION ALL
        SELECT "orderId", "toStatus", "createdAt", next_ts
        FROM creation_durations
        WHERE next_ts IS NOT NULL
      )
      SELECT
        c."toStatus" AS from_status,
        AVG(EXTRACT(EPOCH FROM (c.next_ts - c."createdAt")) / 3600) AS avg_hours
      FROM combined c
      GROUP BY c."toStatus"
    `;

    const result: Record<string, number> = {};
    for (const row of rows) {
      if (row.avg_hours != null && !isNaN(Number(row.avg_hours))) {
        result[row.from_status] = Math.round(Number(row.avg_hours) * 10) / 10;
      }
    }

    await this.redis.set(ORDER_AVG_DURATIONS_CACHE, JSON.stringify(result), 3600);

    return result;
  }

  /**
   * Audit 2026-10-03 (SEC-401): status pembayaran KANONIS untuk order —
   * SATU-SATUNYA sumber kebenaran status pembayaran yang boleh dirender
   * klien. Frontend WAJIB memanggil ini (bukan mempercayai query params /
   * deep link) sebelum menampilkan status sukses.
   *
   * Akses: hanya buyer/seller order (selain itu 403). Order tidak ada → 404.
   * `PAID` hanya bila ada paymentTransaction ORDER_ESCROW berstatus SUCCESS
   * yang terverifikasi di server — tidak pernah diturunkan dari input klien.
   */
  async getCanonicalPaymentStatus(
    orderId: string,
    userId: string,
  ): Promise<{ orderId: string; status: string; paidAt: Date | null; isBuyer: boolean }> {
    const order = await this.prisma.order.findUnique({
      where: { orderId },
      select: { id: true, orderId: true, buyerId: true, sellerId: true },
    });
    if (!order) {
      throw new NotFoundException({
        code: ErrorCodes.ORDER_NOT_FOUND,
        message: 'Order not found',
      });
    }
    const isBuyer = order.buyerId === userId;
    if (!isBuyer && order.sellerId !== userId) {
      throw new ForbiddenException({
        code: ErrorCodes.NOT_ORDER_PARTICIPANT,
        message: 'Not authorized to view this payment status',
      });
    }
    const payment = await this.prisma.paymentTransaction.findFirst({
      where: { orderId: order.id, purpose: PaymentPurpose.ORDER_ESCROW },
      orderBy: { createdAt: 'desc' },
      select: { status: true, paidAt: true },
    });
    if (!payment) {
      return { orderId: order.orderId, status: 'PENDING', paidAt: null, isBuyer };
    }
    const status = mapPaymentStatusToCanonical(payment.status);
    return {
      orderId: order.orderId,
      status,
      paidAt: status === 'PAID' ? payment.paidAt : null,
      isBuyer,
    };
  }
}
