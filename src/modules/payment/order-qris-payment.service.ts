import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ActorType,
  OrderStatus,
  PaymentMethod,
  PaymentPurpose,
  PaymentStatus,
  Prisma,
  WalletTransactionStatus,
  WalletTransactionType,
} from '@prisma/client';
import * as ErrorCodes from '../../common/constants/error-codes';
import { MAX_ESCROW_BALANCE } from '../../common/constants/app.constants';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { toIdr, toSen } from '../../common/utils/currency.util';
import { addDays } from '../../common/utils/date.util';
import { generatePaymentTxId, generateWalletTxId } from '../../common/utils/id-generator.util';
import { PrismaService } from '../../prisma/prisma.service';
import { MidtransService } from './midtrans.service';

const DEFAULT_QRIS_EXPIRY_MINUTES = 30;

export interface OrderQrisPaymentResult {
  paymentTxId: string;
  orderId: string;
  status: PaymentStatus;
  escrowAmount: number;
  providerFee: number;
  grossAmount: number;
  qrString: string | null;
  qrCodeUrl: string | null;
  expiryTime: Date;
}

@Injectable()
export class OrderQrisPaymentService {
  private readonly logger = new Logger(OrderQrisPaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly midtrans: MidtransService,
    private readonly config: ConfigService,
    private readonly walletTxSerialService: WalletTxSerialService,
  ) {}

  private qrisFee(amount: number): number {
    const percentage = this.config.get<number>('app.paymentFeeQrisPercent') ?? 0.7;
    const basisPoints = Math.round(percentage * 100);
    return Math.ceil((amount * basisPoints) / 10_000);
  }

  private expiryAt(): Date {
    const configured =
      this.config.get<number>('app.orderQrisExpiryMinutes') ?? DEFAULT_QRIS_EXPIRY_MINUTES;
    const minutes = Math.min(Math.max(Math.floor(configured), 5), 24 * 60);
    return new Date(Date.now() + minutes * 60_000);
  }

  private parseGrossAmountToSen(raw: string): bigint {
    if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) {
      throw new BadRequestException({
        code: 'WEBHOOK_INVALID_GROSS_AMOUNT',
        message: 'Invalid provider gross amount',
      });
    }
    const [whole, fraction = ''] = raw.split('.');
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  }

  private serializePayment(payment: {
    midtransOrderId: string;
    status: PaymentStatus;
    amount: bigint;
    paymentFee: bigint;
    grossAmount: bigint;
    expiredAt: Date | null;
    providerInstructions: Prisma.JsonValue | null;
  }): OrderQrisPaymentResult {
    const instructions = payment.providerInstructions;
    const qrString =
      instructions &&
      typeof instructions === 'object' &&
      !Array.isArray(instructions) &&
      typeof instructions.qrString === 'string'
        ? instructions.qrString
        : null;
    const qrCodeUrl =
      instructions &&
      typeof instructions === 'object' &&
      !Array.isArray(instructions) &&
      typeof instructions.qrCodeUrl === 'string'
        ? instructions.qrCodeUrl
        : null;

    return {
      paymentTxId: payment.midtransOrderId,
      orderId: '',
      status: payment.status,
      escrowAmount: toIdr(payment.amount),
      providerFee: toIdr(payment.paymentFee),
      grossAmount: toIdr(payment.grossAmount),
      qrString,
      qrCodeUrl,
      expiryTime: payment.expiredAt ?? new Date(),
    };
  }

  async initiate(orderId: string, buyerId: string): Promise<OrderQrisPaymentResult> {
    const order = await this.prisma.order.findUnique({
      where: { orderId },
      include: { buyer: { select: { id: true, email: true, fullName: true } } },
    });
    if (!order)
      throw new BadRequestException({
        code: ErrorCodes.ORDER_NOT_FOUND,
        message: 'Order not found',
      });
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
        status: PaymentStatus.PENDING,
        OR: [{ expiredAt: { gt: now } }, { expiredAt: null }],
      },
      orderBy: { createdAt: 'desc' },
      select: {
        midtransOrderId: true,
        status: true,
        amount: true,
        paymentFee: true,
        grossAmount: true,
        expiredAt: true,
        providerInstructions: true,
      },
    });
    if (activePayment) {
      const instructions = activePayment.providerInstructions;
      const hasQrInstructions =
        instructions &&
        typeof instructions === 'object' &&
        !Array.isArray(instructions) &&
        typeof instructions.qrCodeUrl === 'string' &&
        instructions.qrCodeUrl.length > 0;
      if (!hasQrInstructions) {
        throw new ServiceUnavailableException({
          code: 'QRIS_INSTRUCTIONS_PENDING',
          message: 'QRIS payment is still being reconciled. Check payment status before retrying.',
        });
      }
      return { ...this.serializePayment(activePayment), orderId };
    }

    const escrowAmount = toIdr(order.buyerPayAmount);
    const providerFee = this.qrisFee(escrowAmount);
    const grossAmount = escrowAmount + providerFee;
    const expiredAt = this.expiryAt();
    const paymentTxId = generatePaymentTxId(
      await this.walletTxSerialService.getNextForPrefix('payment_serial'),
    );

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
          purpose: PaymentPurpose.ORDER_ESCROW,
          method: PaymentMethod.QRIS,
          status: PaymentStatus.PENDING,
          amount: order.buyerPayAmount,
          paymentFee: toSen(providerFee),
          grossAmount: toSen(grossAmount),
          expiredAt,
        },
        select: { id: true },
      });
    });

    try {
      const charge = await this.midtrans.chargeTransaction({
        orderId: paymentTxId,
        grossAmount,
        paymentMethod: PaymentMethod.QRIS,
        userEmail: order.buyer.email ?? '',
        fullName: order.buyer.fullName ?? 'Kahade User',
      });
      if (
        charge.grossAmount &&
        this.parseGrossAmountToSen(charge.grossAmount) !== toSen(grossAmount)
      ) {
        throw new ServiceUnavailableException({
          code: 'QRIS_GROSS_AMOUNT_MISMATCH',
          message: 'Payment provider returned a different gross amount',
        });
      }
      if (!charge.transactionId || !charge.qrCodeUrl) {
        throw new ServiceUnavailableException({
          code: 'QRIS_INSTRUCTIONS_UNAVAILABLE',
          message: 'QRIS provider did not return complete payment instructions',
        });
      }
      const chargeExpiry = charge.expiryTime ? new Date(charge.expiryTime) : expiredAt;
      const instructions: Prisma.InputJsonValue = {
        qrString: charge.qrString ?? null,
        qrCodeUrl: charge.qrCodeUrl ?? null,
        actions: charge.actions ?? [],
        paymentType: charge.paymentType,
        providerTransactionId: charge.transactionId,
      };
      const updated = await this.prisma.paymentTransaction.update({
        where: { id: payment.id },
        data: {
          providerInstructions: instructions,
          qrCodeUrl: charge.qrCodeUrl,
          expiredAt: Number.isNaN(chargeExpiry.getTime()) ? expiredAt : chargeExpiry,
        },
        select: {
          midtransOrderId: true,
          status: true,
          amount: true,
          paymentFee: true,
          grossAmount: true,
          expiredAt: true,
          providerInstructions: true,
        },
      });
      return { ...this.serializePayment(updated), orderId };
    } catch (error) {
      this.logger.error(
        `QRIS order charge requires reconciliation: order=${orderId} payment=${paymentTxId}`,
        error instanceof Error ? error.stack : error,
      );
      throw error;
    }
  }

  async getStatus(orderId: string, buyerId: string): Promise<OrderQrisPaymentResult | null> {
    const order = await this.prisma.order.findUnique({
      where: { orderId },
      select: { id: true, buyerId: true },
    });
    if (!order)
      throw new BadRequestException({
        code: ErrorCodes.ORDER_NOT_FOUND,
        message: 'Order not found',
      });
    if (order.buyerId !== buyerId)
      throw new BadRequestException({
        code: ErrorCodes.NOT_ORDER_PARTICIPANT,
        message: 'Not authorized to view this payment',
      });
    const payment = await this.prisma.paymentTransaction.findFirst({
      where: { orderId: order.id, purpose: PaymentPurpose.ORDER_ESCROW },
      orderBy: { createdAt: 'desc' },
      select: {
        midtransOrderId: true,
        status: true,
        amount: true,
        paymentFee: true,
        grossAmount: true,
        expiredAt: true,
        providerInstructions: true,
      },
    });
    return payment ? { ...this.serializePayment(payment), orderId } : null;
  }

  async handleSettlement(midtransOrderId: string, grossAmount: string): Promise<void> {
    const payment = await this.prisma.paymentTransaction.findUnique({
      where: { midtransOrderId },
      select: { id: true, purpose: true, grossAmount: true },
    });
    if (!payment || payment.purpose !== PaymentPurpose.ORDER_ESCROW) {
      throw new BadRequestException({
        code: 'ORDER_QRIS_PAYMENT_NOT_FOUND',
        message: 'QRIS order payment not found',
      });
    }
    if (payment.grossAmount !== this.parseGrossAmountToSen(grossAmount)) {
      throw new BadRequestException({
        code: 'WEBHOOK_AMOUNT_MISMATCH',
        message: 'Provider gross amount does not match the QRIS order payment',
      });
    }

    const walletTxSerial = await this.walletTxSerialService.getNext();
    let refundReason: string | null = null;

    await this.prisma.$transaction(
      async tx => {
        const freshPayment = await tx.paymentTransaction.findUnique({
          where: { id: payment.id },
          include: { order: true },
        });
        if (!freshPayment || freshPayment.status !== PaymentStatus.PENDING) return;
        const order = freshPayment.order;
        if (!order) {
          await tx.paymentTransaction.update({
            where: { id: freshPayment.id },
            data: { status: PaymentStatus.SUCCESS, paidAt: new Date(), settledAt: new Date() },
          });
          refundReason = 'Order payment is no longer linked to an order';
          return;
        }
        if (
          order.status !== OrderStatus.WAITING_PAYMENT ||
          (order.paymentDeadlineAt && Date.now() >= order.paymentDeadlineAt.getTime())
        ) {
          await tx.paymentTransaction.update({
            where: { id: freshPayment.id },
            data: { status: PaymentStatus.SUCCESS, paidAt: new Date(), settledAt: new Date() },
          });
          refundReason = 'Order is no longer eligible to receive an escrow payment';
          return;
        }

        const wallet = await tx.wallet.findUnique({ where: { userId: order.buyerId } });
        if (!wallet || wallet.isLocked) {
          await tx.paymentTransaction.update({
            where: { id: freshPayment.id },
            data: { status: PaymentStatus.SUCCESS, paidAt: new Date(), settledAt: new Date() },
          });
          refundReason = 'Buyer wallet cannot receive escrow funds';
          return;
        }
        const maxEscrowSen = BigInt(MAX_ESCROW_BALANCE) * 100n;
        if (wallet.escrowBalance + freshPayment.amount > maxEscrowSen) {
          await tx.paymentTransaction.update({
            where: { id: freshPayment.id },
            data: { status: PaymentStatus.SUCCESS, paidAt: new Date(), settledAt: new Date() },
          });
          refundReason = 'Buyer escrow balance limit would be exceeded';
          return;
        }

        const walletUpdated = await tx.wallet.updateMany({
          where: { id: wallet.id, version: wallet.version },
          data: {
            escrowBalance: { increment: freshPayment.amount },
            totalBalance: { increment: freshPayment.amount },
            version: { increment: 1 },
          },
        });
        if (walletUpdated.count !== 1) {
          throw new ConflictException({
            code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
            message: 'Concurrent wallet update detected, retry settlement',
          });
        }

        await tx.walletTransaction.create({
          data: {
            txId: generateWalletTxId(walletTxSerial),
            walletId: wallet.id,
            type: WalletTransactionType.ORDER_LOCK,
            status: WalletTransactionStatus.SUCCESS,
            amount: freshPayment.amount,
            balanceBefore: wallet.totalBalance,
            balanceAfter: wallet.totalBalance + freshPayment.amount,
            orderId: order.id,
            paymentTxId: freshPayment.id,
            description: `QRIS escrow lock for order ${order.orderId}`,
            metadata: { paymentSource: 'QRIS', providerFee: toIdr(freshPayment.paymentFee) },
          },
        });

        const orderUpdated = await tx.order.updateMany({
          where: { id: order.id, status: OrderStatus.WAITING_PAYMENT },
          data: {
            status: OrderStatus.PROCESSING,
            paidAt: new Date(),
            processedAt: new Date(),
            deliveryDeadlineAt: addDays(new Date(), order.deliveryDeadlineDays ?? 3),
          },
        });
        if (orderUpdated.count !== 1) {
          throw new ConflictException({
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
            reason: 'QRIS payment settled',
          },
        });
        await tx.paymentTransaction.update({
          where: { id: freshPayment.id },
          data: { status: PaymentStatus.SUCCESS, paidAt: new Date(), settledAt: new Date() },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    if (refundReason) {
      await this.requestRefund(midtransOrderId, refundReason);
    }
  }

  async handleFailure(midtransOrderId: string, providerStatus: string): Promise<void> {
    const status =
      providerStatus.toLowerCase() === 'expire' ? PaymentStatus.EXPIRED : PaymentStatus.FAILED;
    await this.prisma.paymentTransaction.updateMany({
      where: {
        midtransOrderId,
        purpose: PaymentPurpose.ORDER_ESCROW,
        status: PaymentStatus.PENDING,
      },
      data: { status, failedAt: new Date() },
    });
  }

  async requestRefund(midtransOrderId: string, reason: string): Promise<void> {
    const payment = await this.prisma.paymentTransaction.findUnique({ where: { midtransOrderId } });
    if (
      !payment ||
      payment.purpose !== PaymentPurpose.ORDER_ESCROW ||
      payment.status === PaymentStatus.REFUNDED
    )
      return;
    const refundReference = payment.refundReference ?? `RFD-${payment.id}`;
    const claimTime = new Date();
    const claimed = await this.prisma.paymentTransaction.updateMany({
      where: { id: payment.id, refundRequestedAt: null },
      data: { refundRequestedAt: claimTime, refundReference, refundReason: reason.slice(0, 500) },
    });
    if (claimed.count !== 1) return;
    try {
      await this.midtrans.refundTransaction(
        midtransOrderId,
        toIdr(payment.grossAmount),
        refundReference,
        reason.slice(0, 200),
      );
    } catch (error) {
      // Release only our claim so a durable retry can safely attempt the same
      // provider idempotency reference after a confirmed request failure.
      await this.prisma.paymentTransaction
        .updateMany({
          where: { id: payment.id, refundRequestedAt: claimTime },
          data: { refundRequestedAt: null },
        })
        .catch(releaseError =>
          this.logger.error(
            `Failed to release refund claim for ${midtransOrderId}: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
          ),
        );
      throw error;
    }
  }

  async requestRefundForOrder(orderId: string, reason: string): Promise<void> {
    const payment = await this.prisma.paymentTransaction.findFirst({
      where: {
        order: { orderId },
        purpose: PaymentPurpose.ORDER_ESCROW,
        status: PaymentStatus.SUCCESS,
      },
      orderBy: { settledAt: 'desc' },
      select: { midtransOrderId: true },
    });
    if (payment) await this.requestRefund(payment.midtransOrderId, reason);
  }

  async cancelPendingPaymentForOrder(orderId: string): Promise<void> {
    const payment = await this.prisma.paymentTransaction.findFirst({
      where: {
        order: { orderId },
        purpose: PaymentPurpose.ORDER_ESCROW,
        status: PaymentStatus.PENDING,
      },
      orderBy: { createdAt: 'desc' },
      select: { midtransOrderId: true },
    });
    if (!payment) return;
    try {
      await this.midtrans.cancelTransaction(payment.midtransOrderId);
    } catch (error) {
      // Cancellation can race a settlement. The settlement path identifies the already-cancelled
      // order and requests a refund to the original QRIS channel instead of crediting the wallet.
      this.logger.warn(
        `Provider QRIS cancellation could not be confirmed for ${payment.midtransOrderId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async handleRefund(midtransOrderId: string, refundReference: string): Promise<void> {
    const payment = await this.prisma.paymentTransaction.findUnique({
      where: { midtransOrderId },
      include: { order: true },
    });
    if (
      !payment ||
      payment.purpose !== PaymentPurpose.ORDER_ESCROW ||
      payment.status === PaymentStatus.REFUNDED
    )
      return;
    const order = payment.order;
    if (!order || order.status !== OrderStatus.CANCELLED) {
      throw new ServiceUnavailableException({
        code: 'ORDER_QRIS_REFUND_REQUIRES_REVIEW',
        message: 'QRIS refund for a non-cancelled order requires manual review',
      });
    }

    const refundSerial = await this.walletTxSerialService.getNext();
    await this.prisma.$transaction(
      async tx => {
        const freshPayment = await tx.paymentTransaction.findUnique({ where: { id: payment.id } });
        if (!freshPayment || freshPayment.status === PaymentStatus.REFUNDED) return;
        const escrowLock = await tx.walletTransaction.findFirst({
          where: {
            paymentTxId: freshPayment.id,
            type: WalletTransactionType.ORDER_LOCK,
            status: WalletTransactionStatus.SUCCESS,
          },
        });
        if (!escrowLock) {
          throw new ServiceUnavailableException({
            code: 'ORDER_QRIS_REFUND_LEDGER_MISSING',
            message: 'QRIS refund has no escrow lock ledger; manual reconciliation is required',
          });
        }
        if (escrowLock) {
          const wallet = await tx.wallet.findUnique({ where: { id: escrowLock.walletId } });
          if (
            !wallet ||
            wallet.escrowBalance < freshPayment.amount ||
            wallet.totalBalance < freshPayment.amount
          ) {
            throw new ServiceUnavailableException({
              code: 'ORDER_QRIS_REFUND_LEDGER_INVALID',
              message: 'QRIS escrow refund requires ledger review',
            });
          }
          const walletUpdated = await tx.wallet.updateMany({
            where: {
              id: wallet.id,
              version: wallet.version,
              escrowBalance: { gte: freshPayment.amount },
              totalBalance: { gte: freshPayment.amount },
            },
            data: {
              escrowBalance: { decrement: freshPayment.amount },
              totalBalance: { decrement: freshPayment.amount },
              version: { increment: 1 },
            },
          });
          if (walletUpdated.count !== 1)
            throw new ConflictException({
              code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
              message: 'Concurrent wallet refund detected, retry provider webhook',
            });
          await tx.walletTransaction.create({
            data: {
              txId: generateWalletTxId(refundSerial),
              walletId: wallet.id,
              type: WalletTransactionType.ORDER_REFUND,
              status: WalletTransactionStatus.SUCCESS,
              amount: freshPayment.amount,
              balanceBefore: wallet.totalBalance,
              balanceAfter: wallet.totalBalance - freshPayment.amount,
              orderId: payment.orderId,
              paymentTxId: freshPayment.id,
              description: `QRIS refund to original payment channel for order ${order.orderId}`,
              metadata: { paymentSource: 'QRIS', refundReference },
            },
          });
        }
        await tx.paymentTransaction.update({
          where: { id: freshPayment.id },
          data: {
            status: PaymentStatus.REFUNDED,
            refundReference,
            refundRequestedAt: freshPayment.refundRequestedAt ?? new Date(),
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}
