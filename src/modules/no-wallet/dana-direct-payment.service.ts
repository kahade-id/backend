import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import {
  ActorType,
  OrderStatus,
  PaymentMethod,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import * as ErrorCodes from '../../common/constants/error-codes';
import { PROCESSING_DEADLINE_DAYS } from '../../common/constants/app.constants';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { toIdr, toSen } from '../../common/utils/currency.util';
import { addDays, resolveDeliveryDeadlineAt } from '../../common/utils/date.util';
import { generatePaymentTxId } from '../../common/utils/id-generator.util';
import { PrismaService } from '../../prisma/prisma.service';
import { activateMilestonesForOrderTx, activateMilestonesForOrderNoWalletTx } from '../milestones/milestone-activation';
import { DanaPaymentService } from '../payment/dana/dana-payment.service';
import { WalletModeService } from '../wallet-mode/wallet-mode.service';
import { DanaDirectPayDto, DanaDirectPayKind } from './dto/dana-direct-pay.dto';

const DEFAULT_DANA_EXPIRY_MINUTES = 30;

/** partnerReferenceNo DANA: maks 25 char (wajib untuk QRIS). Format KDH-<12 alnum>. */
export function generateDanaPartnerReferenceNo(): string {
  return `KDH-${randomBytes(9).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 12)}`;
}

export interface DanaDirectPayResult {
  paymentTxId: string;
  orderId: string;
  status: PaymentStatus;
  payKind: DanaDirectPayKind;
  escrowAmount: number;
  providerFee: number;
  grossAmount: number;
  /** VA: kode bayar. QRIS: string QR. BALANCE: null (buyer otorisasi di DANA). */
  paymentCode: string | null;
  qrString: string | null;
  webRedirectUrl: string | null;
  expiryTime: Date;
  /**
   * BFI-084: info refund ADITIF — hanya diisi bila ada refund
   * (PaymentTransaction.refundedAmount > 0). FE membaca defensif (null →
   * tidak tampil). Tanpa query tambahan: semua field sudah di baris yang sama.
   */
  refund?: {
    /** "REFUNDED" (penuh) | "PARTIAL" (parsial). */
    status: 'REFUNDED' | 'PARTIAL';
    /** Rupiah. */
    amount: number;
    refundedAt: string | null;
    refundReference: string | null;
  } | null;
}

export interface DanaPaymentMethodInfo {
  kind: DanaDirectPayKind;
  label: string;
  requiresBankCode: boolean;
  banks?: string[];
}

/**
 * Daftar metode bayar DANA yang didukung — BUKAN hardcode QRIS.
 * Daftar bank VA = yang dipetakan mapVaMethod di bawah (DANA auto-generate
 * kode VA per bank via payOption VIRTUAL_ACCOUNT_<BANK>).
 */
export const DANA_DIRECT_VA_BANKS = ['BCA', 'BNI', 'BRI', 'MANDIRI', 'CIMB', 'PERMATA'] as const;

export function listDanaDirectPaymentMethods(): DanaPaymentMethodInfo[] {
  return [
    { kind: DanaDirectPayKind.QRIS, label: 'QRIS', requiresBankCode: false },
    {
      kind: DanaDirectPayKind.VA,
      label: 'Virtual Account',
      requiresBankCode: true,
      banks: [...DANA_DIRECT_VA_BANKS],
    },
    { kind: DanaDirectPayKind.BALANCE, label: 'Saldo DANA', requiresBankCode: false },
  ];
}

function mapVaMethod(bankCode: string): PaymentMethod {
  const bank = bankCode.toUpperCase();
  switch (bank) {
    case 'BCA':
      return PaymentMethod.VIRTUAL_ACCOUNT_BCA;
    case 'BNI':
      return PaymentMethod.VIRTUAL_ACCOUNT_BNI;
    case 'BRI':
      return PaymentMethod.VIRTUAL_ACCOUNT_BRI;
    case 'MANDIRI':
      return PaymentMethod.VIRTUAL_ACCOUNT_MANDIRI;
    case 'CIMB':
      return PaymentMethod.VIRTUAL_ACCOUNT_CIMB;
    case 'PERMATA':
      return PaymentMethod.VIRTUAL_ACCOUNT_PERMATA;
    default:
      return PaymentMethod.VIRTUAL_ACCOUNT_OTHER;
  }
}

/**
 * Misi tanpa-wallet (BI-safe): checkout escrow LANGSUNG via DANA.
 *
 * Buyer pilih metode (QRIS / VA bank / DANA Balance) → Create Order DANA →
 * buyer bayar ke DANA → webhook finish-notify → `settleEscrow` mendanai
 * escrow TANPA menyentuh wallet internal (tidak ada top-up).
 *
 * Signature verification webhook, replay protection (webhookLog), idempotency
 * (merchantId + partnerReferenceNo), dan verify-via-API + pencocokan nominal
 * ditangani di DanaWebhookSettlementService sebelum memanggil settleEscrow —
 * pola keamanan yang sama seperti jalur QRIS existing.
 */
@Injectable()
export class DanaDirectPaymentService {
  private readonly logger = new Logger(DanaDirectPaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly danaPayment: DanaPaymentService,
    private readonly config: ConfigService,
    private readonly walletTxSerialService: WalletTxSerialService,
    private readonly walletMode: WalletModeService,
  ) {}

  /** Fee provider per metode (basis points dari gross escrow). Default QRIS 0.7%. */
  private feeFor(payKind: DanaDirectPayKind, escrowAmountIdr: number): number {
    const bps =
      payKind === DanaDirectPayKind.QRIS
        ? (this.config.get<number>('app.danaPaymentFeeQrisBps') ?? 70)
        : (this.config.get<number>('app.danaPaymentFeeVaBps') ?? 0);
    return Math.ceil((escrowAmountIdr * bps) / 10_000);
  }

  private expiryAt(): Date {
    const configured =
      this.config.get<number>('app.danaDirectExpiryMinutes') ?? DEFAULT_DANA_EXPIRY_MINUTES;
    const minutes = Math.min(Math.max(Math.floor(configured), 5), 24 * 60);
    return new Date(Date.now() + minutes * 60_000);
  }

  private serialize(
    payment: {
      midtransOrderId: string;
      status: PaymentStatus;
      amount: bigint;
      paymentFee: bigint;
      grossAmount: bigint;
      expiredAt: Date | null;
      danaPayKind: string | null;
      providerInstructions: Prisma.JsonValue | null;
      refundedAmount: bigint;
      refundRequestedAt: Date | null;
      refundReference: string | null;
    },
    orderId: string,
  ): DanaDirectPayResult {
    const instructions =
      payment.providerInstructions &&
      typeof payment.providerInstructions === 'object' &&
      !Array.isArray(payment.providerInstructions)
        ? (payment.providerInstructions as Record<string, unknown>)
        : {};
    return {
      paymentTxId: payment.midtransOrderId,
      orderId,
      status: payment.status,
      payKind: (payment.danaPayKind as DanaDirectPayKind) ?? DanaDirectPayKind.QRIS,
      escrowAmount: toIdr(payment.amount),
      providerFee: toIdr(payment.paymentFee),
      grossAmount: toIdr(payment.grossAmount),
      paymentCode:
        typeof instructions.paymentCode === 'string' ? instructions.paymentCode : null,
      qrString: typeof instructions.qrString === 'string' ? instructions.qrString : null,
      webRedirectUrl:
        typeof instructions.webRedirectUrl === 'string' ? instructions.webRedirectUrl : null,
      expiryTime: payment.expiredAt ?? new Date(),
      // BFI-084: sertakan info refund bila ada (aditif; FE defensif).
      refund:
        payment.refundedAmount > BigInt(0)
          ? {
              status:
                payment.refundedAmount >= payment.grossAmount
                  ? ('REFUNDED' as const)
                  : ('PARTIAL' as const),
              amount: toIdr(payment.refundedAmount),
              refundedAt: payment.refundRequestedAt?.toISOString() ?? null,
              refundReference: payment.refundReference,
            }
          : null,
    };
  }

  /**
   * Buat order DANA untuk pembayaran escrow. Idempoten per order: charge
   * PENDING yang masih berlaku dikembalikan ulang (tidak buat charge ganda).
   */
  async initiate(
    orderId: string,
    buyerId: string,
    dto: DanaDirectPayDto,
  ): Promise<DanaDirectPayResult> {
    const payKind = dto.payKind;
    if (payKind === DanaDirectPayKind.VA && !dto.bankCode) {
      throw new BadRequestException({
        code: 'DANA_VA_BANK_REQUIRED',
        message: 'bankCode wajib untuk pembayaran Virtual Account',
      });
    }

    const order = await this.prisma.order.findFirst({
      where: { orderId, deletedAt: null },
      include: { buyer: { select: { id: true, fullName: true } } },
    });
    if (!order)
      throw new BadRequestException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
    if (order.buyerId !== buyerId)
      throw new BadRequestException({
        code: ErrorCodes.NOT_ORDER_PARTICIPANT,
        message: 'Not authorized to pay this order',
      });
    if (order.status !== OrderStatus.WAITING_PAYMENT) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_ORDER_STATUS,
        message: 'Order is not waiting for payment',
      });
    }
    if (order.paymentDeadlineAt && Date.now() >= order.paymentDeadlineAt.getTime()) {
      throw new BadRequestException({
        code: ErrorCodes.ORDER_PAYMENT_EXPIRED,
        message: 'Payment deadline has passed',
      });
    }

    const now = new Date();
    const activePayment = await this.prisma.paymentTransaction.findFirst({
      where: {
        orderId: order.id,
        purpose: PaymentPurpose.ORDER_ESCROW,
        provider: PaymentProvider.DANA,
        status: PaymentStatus.PENDING,
        OR: [{ expiredAt: { gt: now } }, { expiredAt: null }],
      },
      orderBy: { createdAt: 'desc' },
    });
    if (activePayment) {
      // Charge PENDING yang masih hidup dikembalikan (idempoten) — buyer
      // melanjutkan pembayaran yang sama, bukan charge ganda.
      return this.serialize(activePayment, orderId);
    }

    const escrowAmount = toIdr(order.buyerPayAmount);
    const providerFee = this.feeFor(payKind, escrowAmount);
    const grossAmount = escrowAmount + providerFee;
    const expiredAt = this.expiryAt();
    const paymentTxId = generatePaymentTxId(
      await this.walletTxSerialService.getNextForPrefix('payment_serial'),
    );
    const danaPartnerReferenceNo = generateDanaPartnerReferenceNo();
    const method =
      payKind === DanaDirectPayKind.QRIS
        ? PaymentMethod.QRIS
        : payKind === DanaDirectPayKind.VA
          ? mapVaMethod(dto.bankCode ?? '')
          : PaymentMethod.DANA;

    const payment = await this.prisma.$transaction(async tx => {
      await tx.paymentTransaction.updateMany({
        where: {
          orderId: order.id,
          purpose: PaymentPurpose.ORDER_ESCROW,
          status: PaymentStatus.PENDING,
          expiredAt: { lte: now },
        },
        data: { status: PaymentStatus.EXPIRED, failedAt: now },
      });
      return tx.paymentTransaction.create({
        data: {
          midtransOrderId: paymentTxId,
          userId: buyerId,
          orderId: order.id,
          provider: PaymentProvider.DANA,
          purpose: PaymentPurpose.ORDER_ESCROW,
          method,
          status: PaymentStatus.PENDING,
          amount: order.buyerPayAmount,
          paymentFee: toSen(providerFee),
          grossAmount: toSen(grossAmount),
          danaPartnerReferenceNo,
          danaPayKind: payKind,
          expiredAt,
        },
      });
    });

    try {
      const created = await this.danaPayment.createOrder({
        kind: payKind === DanaDirectPayKind.VA ? 'VA' : payKind === DanaDirectPayKind.BALANCE ? 'BALANCE' : 'QRIS',
        partnerReferenceNo: danaPartnerReferenceNo,
        amountIdr: grossAmount,
        bankCode: dto.bankCode,
        orderTitle: `Kahade escrow ${orderId}`,
        expiryMinutes: Math.round((expiredAt.getTime() - Date.now()) / 60_000),
      });
      const instructions: Prisma.InputJsonValue = {
        paymentCode: created.paymentCode || null,
        webRedirectUrl: created.webRedirectUrl ?? null,
        danaReferenceNo: created.referenceNo,
        payKind,
      };
      const updated = await this.prisma.paymentTransaction.update({
        where: { id: payment.id },
        data: {
          providerInstructions: instructions,
          danaReferenceNo: created.referenceNo || undefined,
          expiredAt: created.expiresAt,
        },
      });
      return this.serialize(updated, orderId);
    } catch (error) {
      // Fail-closed: charge DANA gagal → tandai FAILED agar initiate() bisa
      // retry bersih; tidak ada dana yang bergerak.
      await this.prisma.paymentTransaction
        .updateMany({
          where: { id: payment.id, status: PaymentStatus.PENDING },
          data: { status: PaymentStatus.FAILED, failedAt: new Date() },
        })
        .catch(() => undefined);
      this.logger.error(
        `DANA direct checkout gagal: order=${orderId} payment=${paymentTxId}`,
        error instanceof Error ? error.stack : error,
      );
      throw error;
    }
  }

  /**
   * Verifikasi ringan untuk GET payment-methods: order ada + requester
   * adalah buyer. Tidak mengubah state apa pun.
   */
  async assertOrderPayable(orderId: string, buyerId: string): Promise<void> {
    const order = await this.prisma.order.findFirst({
      where: { orderId, deletedAt: null },
      select: { buyerId: true },
    });
    if (!order)
      throw new BadRequestException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
    if (order.buyerId !== buyerId)
      throw new BadRequestException({
        code: ErrorCodes.NOT_ORDER_PARTICIPANT,
        message: 'Not authorized to view payment methods for this order',
      });
  }

  /**
   * BFI-058: sesi tak valid memakai status HTTP yang tepat — order tidak ada
   * → 404 (bukan 400), bukan peserta → 403 (bukan 400). Body error tetap
   * membawa `code` agar klien bisa memetakan.
   */
  async getStatus(orderId: string, buyerId: string): Promise<DanaDirectPayResult | null> {
    const order = await this.prisma.order.findUnique({
      where: { orderId },
      select: { id: true, buyerId: true },
    });
    if (!order)
      throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
    if (order.buyerId !== buyerId)
      throw new ForbiddenException({
        code: ErrorCodes.NOT_ORDER_PARTICIPANT,
        message: 'Not authorized to view this payment',
      });
    const payment = await this.prisma.paymentTransaction.findFirst({
      where: { orderId: order.id, purpose: PaymentPurpose.ORDER_ESCROW, provider: PaymentProvider.DANA },
      orderBy: { createdAt: 'desc' },
    });
    return payment ? this.serialize(payment, orderId) : null;
  }

  /** Batalkan charge PENDING (best-effort ke DANA) — mis. buyer ganti metode. */
  async cancelPending(orderId: string, buyerId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { orderId },
      select: { id: true, buyerId: true },
    });
    if (!order || order.buyerId !== buyerId)
      throw new BadRequestException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
    const payment = await this.prisma.paymentTransaction.findFirst({
      where: {
        orderId: order.id,
        purpose: PaymentPurpose.ORDER_ESCROW,
        provider: PaymentProvider.DANA,
        status: PaymentStatus.PENDING,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!payment?.danaPartnerReferenceNo) return;
    try {
      await this.danaPayment.cancelOrder(payment.danaPartnerReferenceNo, 'Cancelled by buyer');
    } catch (error) {
      this.logger.warn(
        `DANA cancel best-effort gagal untuk ${payment.danaPartnerReferenceNo}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    await this.prisma.paymentTransaction.updateMany({
      where: { id: payment.id, status: PaymentStatus.PENDING },
      data: { status: PaymentStatus.CANCELLED, failedAt: new Date() },
    });
  }

  /**
   * Settlement escrow DANA-direct — dipanggil webhook SETELAH signature
   * verification + replay protection + verify-via-API + pencocokan nominal.
   *
   * TIDAK menyentuh wallet: escrow "pot"-nya adalah PaymentTransaction
   * (status SUCCESS, purpose ORDER_ESCROW, provider DANA); order → PROCESSING.
   * Dana hanya numpang lewat: buyer → DANA → escrow → (release) rekening bank seller.
   */
  async settleEscrow(paymentDbId: string): Promise<void> {
    await this.prisma.$transaction(
      async tx => {
        const payment = await tx.paymentTransaction.findUnique({
          where: { id: paymentDbId },
          include: { order: true },
        });
        if (!payment || payment.purpose !== PaymentPurpose.ORDER_ESCROW) return;
        // Idempoten: webhook retry / race tidak double-settle.
        if (payment.status !== PaymentStatus.PENDING) return;
        const order = payment.order;
        if (!order) {
          // Order terhapus — tandai SUCCESS agar tidak retry; dana dikembalikan
          // via refund DANA oleh caller (fail-closed, bukan ke wallet).
          await tx.paymentTransaction.update({
            where: { id: payment.id },
            data: { status: PaymentStatus.SUCCESS, paidAt: new Date(), settledAt: new Date() },
          });
          throw new ServiceUnavailableException({
            code: 'DANA_DIRECT_ORDER_MISSING',
            message: 'Order tidak ditemukan — settlement ditahan untuk refund manual via DANA',
          });
        }
        if (
          order.status !== OrderStatus.WAITING_PAYMENT ||
          (order.paymentDeadlineAt && Date.now() >= order.paymentDeadlineAt.getTime())
        ) {
          await tx.paymentTransaction.update({
            where: { id: payment.id },
            data: { status: PaymentStatus.SUCCESS, paidAt: new Date(), settledAt: new Date() },
          });
          throw new ServiceUnavailableException({
            code: 'DANA_DIRECT_ORDER_INELIGIBLE',
            message: 'Order tidak lagi eligible menerima escrow — settlement ditahan untuk refund via DANA',
          });
        }

        // GAP-C (G176): aktivasi milestone setelah escrow lock — sama seperti
        // jalur QRIS, no-op untuk order satu tahap existing.
        // M5 (mode tanpa-wallet): aktivasi dari payment escrow DANA SUCCESS —
        // bukti escrow adalah nominal payment (bukan wallet.escrowBalance);
        // escrowHeld tetap jadi accounting marker per tahap.
        if (this.walletMode.isWalletEnabled()) {
          await activateMilestonesForOrderTx(tx, order.id);
        } else {
          await activateMilestonesForOrderNoWalletTx(tx, order.id, {
            paymentId: payment.id,
            amountSen: payment.amount,
          });
        }

        const paidAt = new Date();
        const orderUpdated = await tx.order.updateMany({
          where: { id: order.id, status: OrderStatus.WAITING_PAYMENT, deletedAt: null },
          data: {
            status: OrderStatus.PROCESSING,
            paidAt,
            processedAt: paidAt,
            deliveryDeadlineAt: resolveDeliveryDeadlineAt(
              order.deliveryDeadlineAt,
              order.deliveryDeadlineDays ?? 3,
            ),
            processingDeadlineAt: addDays(paidAt, PROCESSING_DEADLINE_DAYS),
            // Simpan referensi DANA di order (kolom aditif).
            danaPartnerReferenceNo: payment.danaPartnerReferenceNo,
            danaReferenceNo: payment.danaReferenceNo,
          },
        });
        if (orderUpdated.count !== 1) {
          throw new BadRequestException({
            code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
            message: 'Order status changed during settlement, retry settlement',
          });
        }
        await tx.orderStatusHistory.create({
          data: {
            orderId: order.id,
            fromStatus: OrderStatus.WAITING_PAYMENT,
            toStatus: OrderStatus.PROCESSING,
            changedBy: order.buyerId,
            changedByType: ActorType.BUYER,
            reason: `DANA direct payment settled (${payment.danaPayKind ?? 'QRIS'})`,
          },
        });
        await tx.paymentTransaction.update({
          where: { id: payment.id },
          data: { status: PaymentStatus.SUCCESS, paidAt: new Date(), settledAt: new Date() },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}
