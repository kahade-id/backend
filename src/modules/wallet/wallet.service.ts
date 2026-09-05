import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  Logger,
  UnauthorizedException,
  ServiceUnavailableException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  WalletTransactionType,
  WalletTransactionStatus,
  PaymentMethod,
  KycStatus,
  PaymentStatus,
  WithdrawStatus,
  NotificationType,
  Prisma,
} from '@prisma/client';
import { getCategoryForType } from '../notifications/notification-category.map';
import { randomBytes, randomInt } from 'crypto';
import { toSen, toIdr } from '../../common/utils/currency.util';
import {
  endOfDayWIB,
  formatWIBDate,
  parseDateBoundaryWIB,
  startOfDayWIB,
} from '../../common/utils/date.util';
import {
  decryptAES,
  bcryptHash,
  bcryptCompare,
  hmacPinDigest,
  getBcryptRounds,
} from '../../common/utils/crypto.util';
import {
  generateWalletTxId,
  generatePaymentTxId,
  generateNotifId,
} from '../../common/utils/id-generator.util';
import {
  WALLET_DAILY_TOPUP_LIMIT,
  WALLET_DAILY_WITHDRAW_LIMIT,
  WALLET_MIN_WITHDRAW,
  WALLET_MAX_WITHDRAW_PER_TX,
  WALLET_KYC_FREE_LIMIT,
  WALLET_MIN_TRANSFER,
  WALLET_MAX_TRANSFER_PER_TX,
  WALLET_DAILY_TRANSFER_LIMIT,
  ESCROW_RELEASE_HOLD_HOURS,
  OTP_EXPIRES_MINUTES,
} from '../../common/constants/app.constants';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import { createPaginatedResponse, PaginatedResponse } from '../../common/dto/pagination.dto';
import * as ErrorCodes from '../../common/constants/error-codes';
import { MidtransService } from '../payment/midtrans.service';
import { OtpService } from '../auth/otp.service';
import { OtpType, UserAuditAction } from '@prisma/client';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { EMAIL_QUEUE, EmailJobData } from '../queue/processors/email.processor';
import {
  WALLET_LOCK,
  WALLET_PIN_ATTEMPTS,
  WALLET_PIN_IP_ATTEMPTS,
  WITHDRAW_OTP_COOLDOWN,
  TRANSFER_LOCK,
  DAILY_TRANSFER_AMOUNT,
} from '../../common/constants/redis-keys';

interface WalletSummary {
  availableBalance: number;
  escrowBalance: number;
  totalBalance: number;
  todayTopupAmount: number;
  todayWithdrawAmount: number;
  todayTransferAmount: number;
  dailyTopupLimit: number;
  dailyWithdrawLimit: number;
  dailyTransferLimit: number;
  kycFreeLimit: number;
  hasPin: boolean;
  isLocked: boolean;
  lockReason: string | null;
}

interface TransactionSummary {
  id: string;
  txId: string;
  type: string;
  status: string;
  amount: number;
  description: string | null;
  balanceBefore: number;
  balanceAfter: number;
  createdAt: Date;
  order: { orderId: string; title: string } | null;
}

// Three database attempts can each wait up to 15 seconds. Keep the mutex longer
// than that retry window so confirm, resend, and cancel cannot interleave midway.
const WITHDRAW_LIFECYCLE_LOCK_TTL_SECONDS = 90;

@Injectable()
export class WalletService implements OnModuleInit {
  private readonly logger = new Logger(WalletService.name);
  private readonly dailyTopupLimit: number;
  private readonly dailyWithdrawLimit: number;
  private readonly minWithdraw: number;
  private readonly maxWithdrawPerTx: number;
  private readonly topupExpiryHours: number;
  private readonly walletPinPepper: string;
  private dummyPinHash: string | null = null;
  private readonly paymentFees: {
    bca: number;
    bni: number;
    bri: number;
    mandiri: number;
    permata: number;
    cimb: number;
    qrisBps: number;
    gopayBps: number;
    shopeePayBps: number;
    ccBps: number;
    ccFlat: number;
    cstoreFlat: number;
    akulakuBps: number;
    kredivoBps: number;
  };

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private configService: ConfigService,
    private walletTxSerialService: WalletTxSerialService,
    private auditLog: AuditLogService,
    private midtransService: MidtransService,
    private otpService: OtpService,
    private realtime: RealtimeService,
    @InjectQueue(EMAIL_QUEUE) private readonly emailQueue: Queue<EmailJobData>,
  ) {
    this.dailyTopupLimit =
      this.configService.get<number>('app.walletDailyTopupLimit') ?? WALLET_DAILY_TOPUP_LIMIT;
    this.dailyWithdrawLimit =
      this.configService.get<number>('app.walletDailyWithdrawLimit') ?? WALLET_DAILY_WITHDRAW_LIMIT;
    this.minWithdraw =
      this.configService.get<number>('app.walletMinWithdraw') ?? WALLET_MIN_WITHDRAW;
    if (this.minWithdraw < 10000) {
      throw new Error(`WALLET_MIN_WITHDRAW is ${this.minWithdraw} — must be at least Rp 10,000`);
    }
    this.maxWithdrawPerTx =
      this.configService.get<number>('app.walletMaxWithdrawPerTx') ?? WALLET_MAX_WITHDRAW_PER_TX;
    const rawExpiry = this.configService.get<number>('app.topupExpiryHours') ?? 24;
    this.topupExpiryHours = Math.max(1, rawExpiry);

    const pepper =
      this.configService.get<string>('app.walletPinPepper') ??
      this.configService.get<string>('WALLET_PIN_PEPPER');
    if (!pepper) {
      throw new Error(
        'WALLET_PIN_PEPPER env var is required — set it before starting the application',
      );
    }
    this.walletPinPepper = pepper;

    this.paymentFees = {
      bca: this.configService.get<number>('app.paymentFeeVaBca') ?? 4000,
      bni: this.configService.get<number>('app.paymentFeeVaBni') ?? 4000,
      bri: this.configService.get<number>('app.paymentFeeVaBri') ?? 4000,
      mandiri: this.configService.get<number>('app.paymentFeeVaMandiri') ?? 4000,
      permata: this.configService.get<number>('app.paymentFeeVaPermata') ?? 4000,
      cimb: this.configService.get<number>('app.paymentFeeVaCimb') ?? 4000,
      qrisBps: WalletService.percentToBps(
        this.configService.get<number>('app.paymentFeeQrisPercent') ?? 0.7,
      ),
      gopayBps: WalletService.percentToBps(
        this.configService.get<number>('app.paymentFeeGopayPercent') ?? 2.0,
      ),
      shopeePayBps: WalletService.percentToBps(
        this.configService.get<number>('app.paymentFeeShopeePayPercent') ?? 2.0,
      ),
      ccBps: WalletService.percentToBps(
        this.configService.get<number>('app.paymentFeeCreditCardPercent') ?? 2.9,
      ),
      ccFlat: this.configService.get<number>('app.paymentFeeCreditCardFlat') ?? 2000,
      cstoreFlat: this.configService.get<number>('app.paymentFeeCstoreFlat') ?? 5000,
      akulakuBps: WalletService.percentToBps(
        this.configService.get<number>('app.paymentFeeAkulakuPercent') ?? 3.0,
      ),
      kredivoBps: WalletService.percentToBps(
        this.configService.get<number>('app.paymentFeeKredivoPercent') ?? 3.0,
      ),
    };
  }

  async onModuleInit(): Promise<void> {
    this.dummyPinHash = await bcryptHash('dummy_pin_for_timing_normalization', getBcryptRounds());
  }

  async getWallet(userId: string): Promise<WalletSummary> {
    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet)
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Wallet not found' });

    const todayStartWib = startOfDayWIB();
    const isNewDay = !wallet.lastLimitResetAt || wallet.lastLimitResetAt < todayStartWib;
    const effectiveTopup = isNewDay ? BigInt(0) : wallet.todayTopupAmount;
    const effectiveWithdraw = isNewDay ? BigInt(0) : wallet.todayWithdrawAmount;

    const today = formatWIBDate();
    const dailyKey = DAILY_TRANSFER_AMOUNT(userId, today);
    const currentDailyStr = await this.redis.get(dailyKey).catch(() => null);
    let todayTransferSen = BigInt(0);
    if (currentDailyStr != null) {
      try {
        const parsed = BigInt(currentDailyStr);
        if (parsed >= 0n && parsed <= BigInt(Number.MAX_SAFE_INTEGER)) {
          todayTransferSen = parsed;
        } else {
          this.logger.error(
            `Invalid daily transfer counter range for user=${userId}; treating as zero until reconciliation`,
          );
        }
      } catch {
        this.logger.error(
          `Invalid daily transfer counter encoding for user=${userId}; treating as zero until reconciliation`,
        );
      }
    }

    return {
      availableBalance: toIdr(wallet.availableBalance),
      escrowBalance: toIdr(wallet.escrowBalance),
      totalBalance: toIdr(wallet.totalBalance),
      todayTopupAmount: toIdr(effectiveTopup),
      todayWithdrawAmount: toIdr(effectiveWithdraw),
      todayTransferAmount: toIdr(todayTransferSen),
      dailyTopupLimit: this.dailyTopupLimit,
      dailyWithdrawLimit: this.dailyWithdrawLimit,
      dailyTransferLimit: WALLET_DAILY_TRANSFER_LIMIT,
      kycFreeLimit: WALLET_KYC_FREE_LIMIT,
      hasPin: wallet.walletPinHash !== null && wallet.walletPinHash !== '',
      isLocked: wallet.isLocked,
      lockReason: wallet.isLocked ? 'Your wallet has been locked. Please contact support.' : null,
    };
  }

  async getTransactions(
    userId: string,
    page: number,
    limit: number,
    type?: string,
    from?: string,
    to?: string,
  ): Promise<PaginatedResponse<TransactionSummary>> {
    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet)
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Wallet not found' });

    const safePage = Number.isFinite(page) && Number.isInteger(page) && page > 0 ? page : 1;
    const safeLimit =
      Number.isFinite(limit) && Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
    const skip = (safePage - 1) * safeLimit;
    const where: Prisma.WalletTransactionWhereInput = { walletId: wallet.id };
    if (type) {
      if (Object.values(WalletTransactionType).includes(type as WalletTransactionType)) {
        where.type = type as WalletTransactionType;
      } else {
        throw new BadRequestException({
          code: 'INVALID_TRANSACTION_TYPE',
          message: `Invalid transaction type: "${type}". Valid values: ${Object.values(WalletTransactionType).join(', ')}`,
        });
      }
    }
    if (from || to) {
      const MAX_DATE_RANGE_MS = 90 * 24 * 60 * 60 * 1000;
      where.createdAt = {};
      let fromDate: Date | undefined;
      let toDate: Date | undefined;
      if (from) {
        fromDate = parseDateBoundaryWIB(from, 'start');
        if (!fromDate) {
          throw new BadRequestException({
            code: 'INVALID_DATE_FORMAT',
            message: "Invalid 'from' date format",
          });
        }
        where.createdAt.gte = fromDate;
      }
      if (to) {
        toDate = parseDateBoundaryWIB(to, 'end');
        if (!toDate) {
          throw new BadRequestException({
            code: 'INVALID_DATE_FORMAT',
            message: "Invalid 'to' date format",
          });
        }
        where.createdAt.lte = toDate;
      }
      if (fromDate && !toDate) {
        where.createdAt.lte = new Date(fromDate.getTime() + MAX_DATE_RANGE_MS);
      }
      if (!fromDate && toDate) {
        where.createdAt.gte = new Date(toDate.getTime() - MAX_DATE_RANGE_MS);
      }
      if (fromDate && toDate) {
        if (fromDate.getTime() > toDate.getTime()) {
          throw new BadRequestException({
            code: 'INVALID_DATE_RANGE',
            message: "'from' date must be before 'to' date",
          });
        }
        if (toDate.getTime() - fromDate.getTime() > MAX_DATE_RANGE_MS) {
          throw new BadRequestException({
            code: 'DATE_RANGE_TOO_LARGE',
            message: 'Date range must not exceed 90 days',
          });
        }
      }
    }

    const [transactions, total] = await Promise.all([
      this.prisma.walletTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: safeLimit,
        include: { order: { select: { orderId: true, title: true } } },
      }),
      this.prisma.walletTransaction.count({ where }),
    ]);

    return createPaginatedResponse(
      transactions.map(tx => ({
        id: tx.id,
        txId: tx.txId,
        type: tx.type,
        status: tx.status,
        amount: toIdr(tx.amount),
        description: tx.description as string | null,
        balanceBefore: toIdr(tx.balanceBefore),
        balanceAfter: toIdr(tx.balanceAfter),
        createdAt: tx.createdAt,
        order: tx.order,
      })),
      total,
      safePage,
      safeLimit,
    );
  }

  async getTransactionDetail(userId: string, txId: string): Promise<Record<string, unknown>> {
    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet)
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Wallet not found' });

    const transaction = await this.prisma.walletTransaction.findFirst({
      where: { txId, walletId: wallet.id },
      select: {
        id: true,
        txId: true,
        type: true,
        status: true,
        amount: true,
        description: true,
        balanceBefore: true,
        balanceAfter: true,
        createdAt: true,
        metadata: true,
        order: { select: { orderId: true, title: true, status: true } },
      },
    });
    if (!transaction)
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Transaction not found' });

    return {
      id: transaction.id,
      txId: transaction.txId,
      type: transaction.type,
      status: transaction.status,
      amount: toIdr(transaction.amount),
      description: transaction.description,
      balanceBefore: toIdr(transaction.balanceBefore),
      balanceAfter: toIdr(transaction.balanceAfter),
      createdAt: transaction.createdAt,
      metadata: transaction.metadata,
      order: transaction.order,
    };
  }

  private static percentToBps(pct: number): number {
    return Math.round(pct * 100);
  }

  // Ceiling division: always rounds up so the platform never under-charges fees
  private static feeFromBps(amountIdr: number, bps: number): number {
    const num = amountIdr * bps;
    const base = Math.trunc(num / 10000);
    return num % 10000 !== 0 ? base + 1 : base;
  }

  private calculatePaymentFee(amount: number, method: PaymentMethod): number {
    const f = this.paymentFees;

    switch (method) {
      case PaymentMethod.VIRTUAL_ACCOUNT_BCA:
        return f.bca;
      case PaymentMethod.VIRTUAL_ACCOUNT_BNI:
        return f.bni;
      case PaymentMethod.VIRTUAL_ACCOUNT_BRI:
        return f.bri;
      case PaymentMethod.VIRTUAL_ACCOUNT_MANDIRI:
        return f.mandiri;
      case PaymentMethod.VIRTUAL_ACCOUNT_PERMATA:
        return f.permata;
      case PaymentMethod.VIRTUAL_ACCOUNT_CIMB:
        return f.cimb;
      case PaymentMethod.QRIS:
        return WalletService.feeFromBps(amount, f.qrisBps);
      case PaymentMethod.GOPAY:
        return WalletService.feeFromBps(amount, f.gopayBps);
      case PaymentMethod.SHOPEEPAY:
        return WalletService.feeFromBps(amount, f.shopeePayBps);
      case PaymentMethod.CREDIT_CARD:
        return WalletService.feeFromBps(amount, f.ccBps) + f.ccFlat;
      case PaymentMethod.ALFAMART:
      case PaymentMethod.INDOMARET:
        return f.cstoreFlat;
      case PaymentMethod.AKULAKU:
        return WalletService.feeFromBps(amount, f.akulakuBps);
      case PaymentMethod.KREDIVO:
        return WalletService.feeFromBps(amount, f.kredivoBps);
      default:
        throw new BadRequestException({
          code: ErrorCodes.INVALID_PAYMENT_METHOD,
          message: 'Unsupported payment method',
        });
    }
  }

  async getTopupStatus(
    userId: string,
    paymentTxId: string,
  ): Promise<{ status: PaymentStatus; txId: string; amount: number }> {
    // Mobile clients poll this endpoint after initiating a top-up to learn
    // when the Midtrans webhook has settled the payment. We accept the
    // public-facing `midtransOrderId` (returned to the client as
    // `paymentTxId` from POST /wallet/topup) and scope the lookup to the
    // calling user so it cannot be used to enumerate other users' txs.
    const tx = await this.prisma.paymentTransaction.findFirst({
      where: { midtransOrderId: paymentTxId, userId },
      select: { midtransOrderId: true, status: true, amount: true },
    });
    if (!tx) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Top-up transaction not found',
      });
    }
    return {
      status: tx.status,
      txId: tx.midtransOrderId,
      amount: toIdr(tx.amount),
    };
  }

  async topup(
    userId: string,
    amount: number,
    method: PaymentMethod,
    cardToken?: string,
  ): Promise<Record<string, unknown>> {
    if (
      !Number.isFinite(amount) ||
      !Number.isInteger(amount) ||
      amount <= 0 ||
      amount > Number.MAX_SAFE_INTEGER / 100
    ) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message:
          'Top-up amount must be a finite positive whole IDR amount within the supported range',
      });
    }
    const paymentMethod = (
      this.getPaymentMethods().methods as Array<{
        id: string;
        minAmount: number;
        maxAmount: number;
      }>
    ).find(entry => entry.id === method);
    if (!paymentMethod) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_PAYMENT_METHOD,
        message: 'Unsupported payment method',
      });
    }
    if (amount < paymentMethod.minAmount || amount > paymentMethod.maxAmount) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `Top-up amount for ${method} must be between Rp ${paymentMethod.minAmount.toLocaleString('id-ID')} and Rp ${paymentMethod.maxAmount.toLocaleString('id-ID')}`,
      });
    }
    if (method === PaymentMethod.KAHADE_WALLET) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_PAYMENT_METHOD,
        message: 'Cannot top up using Kahade Wallet balance. Please choose a payment method.',
      });
    }

    const UNSUPPORTED_CORE_API_METHODS: PaymentMethod[] = [
      PaymentMethod.OVO,
      PaymentMethod.DANA,
      PaymentMethod.LINKAJA,
      PaymentMethod.VIRTUAL_ACCOUNT_OTHER,
    ];
    if (UNSUPPORTED_CORE_API_METHODS.includes(method)) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_PAYMENT_METHOD,
        message: `Payment method ${method} is not currently supported for direct top-up.`,
      });
    }

    if (method === PaymentMethod.CREDIT_CARD && !cardToken) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_PAYMENT_METHOD,
        message:
          'Card token is required for credit card payments. Please complete card tokenization first.',
      });
    }

    if (amount > WALLET_KYC_FREE_LIMIT) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { kycStatus: true },
      });
      if (!user || user.kycStatus !== KycStatus.APPROVED) {
        throw new ForbiddenException({
          code: ErrorCodes.KYC_REQUIRED,
          message: `Top-up above Rp ${WALLET_KYC_FREE_LIMIT.toLocaleString('id-ID')} requires KYC verification. Please verify your identity first.`,
        });
      }
    }

    const walletForLock = await this.prisma.wallet.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!walletForLock)
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Wallet not found' });

    const lockKey = WALLET_LOCK(userId);
    const lockToken = `topup:${Date.now()}:${randomBytes(16).toString('hex')}`;
    const acquired = await this.redis.setNx(lockKey, lockToken, 30);
    if (!acquired) {
      throw new ConflictException({
        code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
        message: 'Another wallet operation is in progress. Please try again.',
      });
    }

    try {
      const paymentSerial = await this.getNextPaymentSerial();
      const walletTxSerial = await this.getNextWalletTxSerial();

      const amountInSen = toSen(amount);
      const dailyLimit = toSen(this.dailyTopupLimit);

      const result = await this.prisma.$transaction(
        async (tx: Prisma.TransactionClient) => {
          await tx.$queryRaw`SELECT id FROM wallets WHERE "userId" = ${userId} FOR UPDATE`;
          const wallet = await tx.wallet.findUnique({ where: { userId } });
          if (!wallet)
            throw new NotFoundException({
              code: ErrorCodes.NOT_FOUND,
              message: 'Wallet not found',
            });

          if (wallet.isLocked) {
            this.logger.warn(
              `TOPUP_REJECTED wallet=${wallet.id} user=${userId} reason=wallet_locked amount=${amountInSen}`,
            );
            throw new ForbiddenException({
              code: ErrorCodes.WALLET_LOCKED,
              message: 'Wallet is locked',
            });
          }

          const todayStartWib = startOfDayWIB();
          const effectiveTopup =
            wallet.lastLimitResetAt && wallet.lastLimitResetAt < todayStartWib
              ? BigInt(0)
              : wallet.todayTopupAmount;

          const newTopupAmount = effectiveTopup + amountInSen;
          if (newTopupAmount > dailyLimit) {
            this.logger.warn(
              `TOPUP_REJECTED wallet=${wallet.id} user=${userId} reason=daily_limit_exceeded amount=${amountInSen} todayTotal=${effectiveTopup} limit=${dailyLimit}`,
            );
            throw new BadRequestException({
              code: ErrorCodes.DAILY_TOPUP_LIMIT_EXCEEDED,
              message: 'Daily topup limit exceeded',
            });
          }

          const walletVersion = wallet.version;

          const paymentFee = this.calculatePaymentFee(amount, method);
          const grossAmount = amount + paymentFee;
          const paymentTxId = generatePaymentTxId(paymentSerial);
          const paymentFeeSen = toSen(paymentFee);
          const grossAmountSen = toSen(grossAmount);
          const paymentTx = await tx.paymentTransaction.create({
            data: {
              midtransOrderId: paymentTxId,
              userId,
              method,
              amount: amountInSen,
              paymentFee: paymentFeeSen,
              grossAmount: grossAmountSen,
              status: PaymentStatus.PENDING,
            },
          });

          const walletTxId = generateWalletTxId(walletTxSerial);
          await tx.walletTransaction.create({
            data: {
              txId: walletTxId,
              walletId: wallet.id,
              type: WalletTransactionType.TOP_UP,
              status: WalletTransactionStatus.PENDING,
              amount: amountInSen,
              balanceBefore: wallet.totalBalance,
              balanceAfter: wallet.totalBalance,
              paymentTxId: paymentTx.id,
              description: `Top up via ${method}`,
            },
          });

          const isNewDay = wallet.lastLimitResetAt && wallet.lastLimitResetAt < todayStartWib;
          const topupUpdateData = isNewDay
            ? {
                todayTopupAmount: amountInSen,
                todayWithdrawAmount: BigInt(0),
                lastLimitResetAt: new Date(),
                version: { increment: 1 },
              }
            : { todayTopupAmount: { increment: amountInSen }, version: { increment: 1 } };

          const updated = await tx.wallet.updateMany({
            where: { id: wallet.id, version: walletVersion },
            data: topupUpdateData,
          });

          if (updated.count === 0) {
            throw new ConflictException({
              code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
              message: 'Concurrent wallet update detected, please retry',
            });
          }

          return { paymentTxId, paymentDbId: paymentTx.id, paymentFee, grossAmount };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );

      const topupExpiryMs = this.topupExpiryHours * 60 * 60 * 1000;

      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, fullName: true },
      });

      let chargeResult: import('../payment/midtrans.service').MidtransChargeResult;

      try {
        chargeResult = await this.midtransService.chargeTransaction({
          orderId: result.paymentTxId,
          grossAmount: result.grossAmount,
          paymentMethod: method,
          userEmail: user?.email ?? '',
          fullName: user?.fullName ?? 'Kahade User',
          cardToken,
        });
      } catch (chargeError) {
        this.logger.error(
          `Midtrans Core API charge failed for orderId=${result.paymentTxId}:`,
          chargeError,
        );
        // A rejected client request and a network timeout after Midtrans accepted
        // the request are indistinguishable from the charge adapter's exception.
        // Never roll a top-up back until the provider confirms a terminal failure;
        // otherwise a later settlement webhook would find a FAILED row and a real
        // customer payment could remain uncredited.
        let providerStatus: string | null = null;
        try {
          const providerTransaction = await this.midtransService.getTransactionStatus(
            result.paymentTxId,
          );
          const status = providerTransaction['transaction_status'];
          providerStatus = typeof status === 'string' ? status.toLowerCase() : null;
        } catch (statusError) {
          this.logger.warn(
            `Unable to reconcile failed charge immediately for orderId=${result.paymentTxId}: ` +
              `${statusError instanceof Error ? statusError.message : String(statusError)}`,
          );
        }

        const terminalProviderFailures = new Set(['deny', 'expire', 'cancel', 'failure']);
        if (!providerStatus || !terminalProviderFailures.has(providerStatus)) {
          this.logger.warn(
            `Top-up charge outcome remains uncertain for orderId=${result.paymentTxId}; ` +
              `keeping payment PENDING for webhook/expiry reconciliation (providerStatus=${providerStatus ?? 'unavailable'})`,
          );
          throw new ServiceUnavailableException({
            code: 'PAYMENT_INITIATION_UNCERTAIN',
            message:
              'Payment initiation could not be confirmed. Check the payment status again shortly before trying a new top-up.',
            paymentTxId: result.paymentTxId,
          });
        }

        const MAX_ROLLBACK_RETRIES = 3;
        for (let attempt = 1; attempt <= MAX_ROLLBACK_RETRIES; attempt++) {
          try {
            await this.prisma.$transaction(
              async tx => {
                await tx.paymentTransaction.update({
                  where: { midtransOrderId: result.paymentTxId },
                  data: { status: PaymentStatus.FAILED, failedAt: new Date() },
                });
                await tx.walletTransaction.updateMany({
                  where: {
                    paymentTxId: result.paymentDbId,
                    status: WalletTransactionStatus.PENDING,
                  },
                  data: { status: WalletTransactionStatus.FAILED },
                });
                const walletRows = await tx.$queryRaw<
                  Array<{ id: string; version: number; todayTopupAmount: bigint }>
                >`
                SELECT id, version, "todayTopupAmount" FROM wallets WHERE "userId" = ${userId} FOR UPDATE`;
                const currentWallet = walletRows[0];
                if (currentWallet) {
                  const rollbackResult = await tx.wallet.updateMany({
                    where: { id: currentWallet.id, version: currentWallet.version },
                    data: {
                      todayTopupAmount: {
                        decrement:
                          currentWallet.todayTopupAmount >= amountInSen
                            ? amountInSen
                            : currentWallet.todayTopupAmount,
                      },
                      version: { increment: 1 },
                    },
                  });
                  if (rollbackResult.count === 0) {
                    throw new Error('OCC conflict during topup rollback');
                  }
                }
              },
              { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
            );
            break;
          } catch (rollbackErr) {
            if (attempt === MAX_ROLLBACK_RETRIES) {
              this.logger.error(
                `CRITICAL: Topup rollback failed after ${MAX_ROLLBACK_RETRIES} attempts for user ${userId}. ` +
                  `Daily counter may be overstated. Enqueuing background correction. Error: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
              );
              const correctionData = JSON.stringify({
                userId,
                amountInSen: amountInSen.toString(),
                paymentTxId: result.paymentTxId,
                timestamp: Date.now(),
              });
              const client = this.redis.getClient();
              const listKey = this.redis.getPrefix() + 'topup_counter_corrections';
              client
                .rpush(listKey, correctionData)
                .then(() => {
                  return client.expire(listKey, 7 * 24 * 60 * 60);
                })
                .catch((redisErr: Error) => {
                  this.logger.error(
                    `Failed to enqueue topup counter correction for user ${userId}: ${redisErr.message}`,
                  );
                });
            } else {
              this.logger.warn(
                `Topup rollback attempt ${attempt} failed for user ${userId}, retrying...`,
              );
              await new Promise(r => setTimeout(r, 100 * attempt));
            }
          }
        }
        throw new Error(
          `Payment gateway error: ${chargeError instanceof Error ? chargeError.message : 'Midtrans unavailable'}`,
        );
      }

      const immediateChargeStatus = chargeResult.transactionStatus.toLowerCase();
      const terminalChargeStatuses = new Set([
        'deny',
        'expire',
        'cancel',
        'failure',
        'refund',
        'partial_refund',
        'chargeback',
        'partial_chargeback',
      ]);
      if (terminalChargeStatuses.has(immediateChargeStatus)) {
        // Core API may return a terminal outcome synchronously without a transport
        // error. Resolve local PENDING state now; later webhook delivery is idempotent.
        await this.handleTopupFailure(result.paymentTxId, immediateChargeStatus.toUpperCase());
        throw new BadRequestException({
          code: 'PAYMENT_INITIATION_DECLINED',
          message:
            'Payment provider declined or cancelled this top-up. No payment instruction was created.',
        });
      }
      if (!chargeResult.transactionId) {
        throw new ServiceUnavailableException({
          code: 'PAYMENT_PROVIDER_INCOMPLETE',
          message:
            'Payment provider returned an incomplete transaction response; payment status is still being reconciled.',
        });
      }
      if (
        chargeResult.grossAmount &&
        this.parseProviderAmountToSen(chargeResult.grossAmount, 'gross_amount') !==
          toSen(result.grossAmount)
      ) {
        throw new ServiceUnavailableException({
          code: 'PAYMENT_PROVIDER_AMOUNT_MISMATCH',
          message:
            'Payment provider returned a different gross amount; payment status is still being reconciled.',
        });
      }

      this.auditLog.logUserAction({
        userId,
        action: UserAuditAction.TOPUP_INITIATED,
        entityType: 'WalletTransaction',
        entityId: result.paymentTxId,
        description: `User initiated topup of ${amount} via ${method}`,
      });

      return {
        paymentTxId: result.paymentTxId,
        transactionId: chargeResult.transactionId,
        method,
        amount,
        paymentFee: result.paymentFee,
        grossAmount: result.grossAmount,
        paymentType: chargeResult.paymentType,
        transactionStatus: chargeResult.transactionStatus,
        vaNumber: chargeResult.vaNumber,
        bankName: chargeResult.bankName,
        billKey: chargeResult.billKey,
        billerCode: chargeResult.billerCode,
        qrString: chargeResult.qrString,
        qrCodeUrl: chargeResult.qrCodeUrl,
        paymentCode: chargeResult.paymentCode,
        store: chargeResult.store,
        actions: chargeResult.actions,
        redirectUrl: chargeResult.redirectUrl,
        expiryTime: chargeResult.expiryTime,
        expiredAt: chargeResult.expiryTime
          ? new Date(chargeResult.expiryTime)
          : new Date(Date.now() + topupExpiryMs),
      };
    } finally {
      await this.redis
        .releaseLock(lockKey, lockToken)
        .catch((error: unknown) =>
          this.logger.warn(
            `TOPUP lock release failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
    }
  }

  private async checkPinIpRateLimit(ip?: string): Promise<void> {
    if (!ip) return;
    const ipAttemptKey = WALLET_PIN_IP_ATTEMPTS(ip);
    const rawIpAttempts = await this.redis.get(ipAttemptKey, { throwOnError: true });
    const ipAttempts = rawIpAttempts == null ? 0 : Number(rawIpAttempts);
    if (!Number.isSafeInteger(ipAttempts) || ipAttempts < 0) {
      throw new ServiceUnavailableException({
        code: 'PIN_RATE_LIMIT_UNAVAILABLE',
        message: 'PIN security controls are temporarily unavailable. Please try again later.',
      });
    }
    if (ipAttempts >= 20) {
      throw new ForbiddenException({
        code: ErrorCodes.PIN_IP_RATE_LIMITED,
        message: 'Too many failed PIN attempts from this address. Please try again later.',
      });
    }
  }

  private async incrementPinIpAttempts(ip?: string): Promise<void> {
    if (!ip) return;
    const ipAttemptKey = WALLET_PIN_IP_ATTEMPTS(ip);
    const newCount = await this.redis.incr(ipAttemptKey, { throwOnError: true });
    if (newCount === 1) await this.redis.expire(ipAttemptKey, 3600, { throwOnError: true });
  }

  private getDummyPinHash(): string {
    if (!this.dummyPinHash) {
      throw new Error(
        'Dummy PIN hash not initialized — onModuleInit must complete before verifying PINs',
      );
    }
    return this.dummyPinHash;
  }

  private async verifyWalletPin(
    wallet: { walletPinHash: string | null },
    pin: string,
    userId: string,
    ip?: string,
  ): Promise<void> {
    await this.checkPinIpRateLimit(ip);

    const pinAttemptKey = WALLET_PIN_ATTEMPTS(userId);
    const rawAttempts = await this.redis.get(pinAttemptKey, { throwOnError: true });
    const currentAttempts = rawAttempts == null ? 0 : Number(rawAttempts);
    if (!Number.isSafeInteger(currentAttempts) || currentAttempts < 0) {
      throw new ServiceUnavailableException({
        code: 'PIN_RATE_LIMIT_UNAVAILABLE',
        message: 'PIN security controls are temporarily unavailable. Please try again later.',
      });
    }
    if (currentAttempts >= 5) {
      throw new ForbiddenException({
        code: ErrorCodes.PIN_RATE_LIMITED,
        message: 'Too many failed PIN attempts. Please try again in 15 minutes.',
      });
    }

    const hasPin = wallet.walletPinHash !== null && wallet.walletPinHash !== '';
    const hashToCompare = hasPin ? wallet.walletPinHash! : this.getDummyPinHash();
    const pinDigest = hmacPinDigest(this.walletPinPepper, pin);
    let pinValid = await bcryptCompare(pinDigest, hashToCompare);

    if (!pinValid && hasPin) {
      const legacyValid = await bcryptCompare(this.walletPinPepper + pin, hashToCompare);
      if (legacyValid) {
        pinValid = true;
        const newDigest = hmacPinDigest(this.walletPinPepper, pin);
        const rehashed = await bcryptHash(newDigest, getBcryptRounds());
        await this.prisma.wallet.update({
          where: { userId },
          data: { walletPinHash: rehashed },
        });
      }
    }

    if (!hasPin) {
      throw new BadRequestException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Wallet PIN has not been set. Please set a PIN before proceeding.',
      });
    }

    if (!pinValid) {
      const newCount = await this.redis.incr(pinAttemptKey, { throwOnError: true });
      if (newCount === 1) await this.redis.expire(pinAttemptKey, 900, { throwOnError: true });
      await this.incrementPinIpAttempts(ip);
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Invalid wallet PIN',
      });
    }

    await this.redis.del(pinAttemptKey, { throwOnError: true });
  }

  async withdraw(
    userId: string,
    amount: number,
    bankAccountId: string,
    pin: string,
    ip?: string,
  ): Promise<Record<string, unknown>> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user)
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'User not found' });
    // Withdrawal confirmation is delivered by email. Never create a pending
    // reservation or use an empty-string OTP identity for a phone-only account:
    // that would leave funds held without a deliverable confirmation factor.
    if (!user.email) {
      throw new BadRequestException({
        code: 'EMAIL_NOT_CONFIGURED',
        message: 'Add an email address before requesting a withdrawal confirmation code.',
      });
    }
    if (
      !Number.isFinite(amount) ||
      !Number.isInteger(amount) ||
      amount <= 0 ||
      amount > Number.MAX_SAFE_INTEGER / 100
    ) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message:
          'Withdrawal amount must be a finite positive whole IDR amount within the supported range',
      });
    }
    if (amount > WALLET_KYC_FREE_LIMIT && user.kycStatus !== KycStatus.APPROVED) {
      throw new ForbiddenException({
        code: ErrorCodes.KYC_REQUIRED_FOR_WITHDRAW,
        message: `Withdrawal above Rp ${WALLET_KYC_FREE_LIMIT.toLocaleString('id-ID')} requires KYC verification. Please verify your identity first.`,
      });
    }

    const walletCheck = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!walletCheck)
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Wallet not found' });

    if (walletCheck.isLocked) {
      throw new ForbiddenException({ code: ErrorCodes.WALLET_LOCKED, message: 'Wallet is locked' });
    }

    await this.verifyWalletPin(walletCheck, pin, userId, ip);

    const minWithdraw = toSen(this.minWithdraw);
    const maxWithdrawPerTx = toSen(this.maxWithdrawPerTx);
    const amountInSen = toSen(amount);
    if (amountInSen < minWithdraw) {
      throw new BadRequestException({
        code: ErrorCodes.BELOW_MINIMUM_WITHDRAW,
        message: 'Amount below minimum withdrawal',
      });
    }
    if (amountInSen > maxWithdrawPerTx) {
      throw new BadRequestException({
        code: ErrorCodes.ABOVE_MAXIMUM_WITHDRAW,
        message: `Per-transaction withdrawal limit is Rp ${this.maxWithdrawPerTx.toLocaleString('id-ID')}`,
      });
    }

    const bankAccount = await this.prisma.bankAccount.findFirst({
      where: { id: bankAccountId, userId, deletedAt: null },
    });
    if (!bankAccount)
      throw new NotFoundException({
        code: ErrorCodes.BANK_ACCOUNT_NOT_FOUND,
        message: 'Bank account not found',
      });
    if (!bankAccount.isVerified)
      throw new BadRequestException({
        code: ErrorCodes.BANK_ACCOUNT_NOT_VERIFIED,
        message: 'Bank account must be verified before withdrawal',
      });

    const withdrawLockKey = WALLET_LOCK(userId);
    const withdrawLockToken = `withdraw:${Date.now()}:${randomBytes(16).toString('hex')}`;
    const withdrawLockAcquired = await this.redis.setNx(
      withdrawLockKey,
      withdrawLockToken,
      WITHDRAW_LIFECYCLE_LOCK_TTL_SECONDS,
    );
    if (!withdrawLockAcquired) {
      throw new ConflictException({
        code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
        message: 'Another wallet operation is in progress. Please try again.',
      });
    }

    let walletTxId: string;
    let plainAccountNumber!: string;

    try {
      walletTxId = generateWalletTxId(await this.getNextWalletTxSerial());

      const MAX_RETRIES = 3;
      let lastError: unknown;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await this.prisma.$transaction(
            async (tx: Prisma.TransactionClient) => {
              const lockedRows = await tx.$queryRaw<
                Array<{ id: string }>
              >`SELECT id FROM wallets WHERE id = ${walletCheck.id} FOR UPDATE`;
              const lockedWallet = await tx.wallet.findUnique({ where: { id: walletCheck.id } });

              if (!lockedWallet || lockedRows.length === 0) {
                throw new NotFoundException({
                  code: ErrorCodes.NOT_FOUND,
                  message: 'Wallet not found',
                });
              }
              if (lockedWallet.isLocked) {
                throw new ForbiddenException({
                  code: ErrorCodes.WALLET_LOCKED,
                  message: 'Wallet is locked',
                });
              }
              const pendingOtpWithdrawal = await tx.walletTransaction.findFirst({
                where: {
                  walletId: lockedWallet.id,
                  type: WalletTransactionType.WITHDRAW,
                  status: WalletTransactionStatus.PENDING,
                  withdrawStatus: WithdrawStatus.PENDING_OTP,
                },
                select: { txId: true },
              });
              if (pendingOtpWithdrawal) {
                throw new ConflictException({
                  code: ErrorCodes.BANK_ACCOUNT_HAS_PENDING_WITHDRAWAL,
                  message:
                    'A withdrawal is already awaiting OTP confirmation. Confirm or cancel it before starting another withdrawal.',
                });
              }

              const verifiedBankAccount = await tx.bankAccount.findFirst({
                where: { id: bankAccountId, userId, deletedAt: null },
              });
              if (!verifiedBankAccount) {
                throw new NotFoundException({
                  code: ErrorCodes.BANK_ACCOUNT_NOT_FOUND,
                  message: 'Bank account not found or no longer belongs to user',
                });
              }
              if (!verifiedBankAccount.isVerified) {
                throw new BadRequestException({
                  code: ErrorCodes.BANK_ACCOUNT_NOT_VERIFIED,
                  message: 'Bank account must remain verified before withdrawal',
                });
              }

              plainAccountNumber = await decryptAES(verifiedBankAccount.accountNumber);

              const todayStartWib = startOfDayWIB();
              const effectiveWithdraw =
                lockedWallet.lastLimitResetAt && lockedWallet.lastLimitResetAt < todayStartWib
                  ? BigInt(0)
                  : lockedWallet.todayWithdrawAmount;

              const newWithdrawAmount = effectiveWithdraw + amountInSen;
              const dailyLimit = toSen(this.dailyWithdrawLimit);
              if (newWithdrawAmount > dailyLimit) {
                this.logger.warn(
                  `WITHDRAW_REJECTED wallet=${walletCheck.id} user=${userId} reason=daily_limit_exceeded amount=${amountInSen} todayTotal=${effectiveWithdraw} limit=${dailyLimit} ip=${ip ?? 'unknown'}`,
                );
                throw new BadRequestException({
                  code: ErrorCodes.DAILY_WITHDRAW_LIMIT_EXCEEDED,
                  message: 'Daily withdrawal limit exceeded',
                });
              }
              const heldAmount = await this.getHeldEscrowReleaseAmount(tx, lockedWallet.id);
              const withdrawableBalance = lockedWallet.availableBalance - heldAmount;
              if (withdrawableBalance < amountInSen) {
                this.logger.warn(
                  `WITHDRAW_REJECTED wallet=${walletCheck.id} user=${userId} reason=insufficient_withdrawable amount=${amountInSen} withdrawable=${withdrawableBalance} held=${heldAmount} ip=${ip ?? 'unknown'}`,
                );
                throw new BadRequestException({
                  code: ErrorCodes.INSUFFICIENT_BALANCE,
                  message:
                    'Insufficient withdrawable balance. Some funds from recent order completions are still in a holding period.',
                });
              }

              const needsLazyReset =
                lockedWallet.lastLimitResetAt && lockedWallet.lastLimitResetAt < todayStartWib;
              const withdrawUpdateData = needsLazyReset
                ? {
                    availableBalance: { decrement: amountInSen },
                    totalBalance: { decrement: amountInSen },
                    todayTopupAmount: BigInt(0),
                    todayWithdrawAmount: amountInSen,
                    lastLimitResetAt: new Date(),
                    version: { increment: 1 },
                  }
                : {
                    availableBalance: { decrement: amountInSen },
                    totalBalance: { decrement: amountInSen },
                    todayWithdrawAmount: { increment: amountInSen },
                    version: { increment: 1 },
                  };

              const updated = await tx.wallet.updateMany({
                where: {
                  id: walletCheck.id,
                  version: lockedWallet.version,
                  availableBalance: { gte: amountInSen },
                },
                data: withdrawUpdateData,
              });

              if (updated.count === 0) {
                throw new ConflictException({
                  code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                  message: 'Concurrent update detected, please retry',
                });
              }

              const sanitizedBankName = (verifiedBankAccount.bankName ?? '')
                .replace(/[^\w\s\-&.]/g, '')
                .slice(0, 50);
              await tx.walletTransaction.create({
                data: {
                  txId: walletTxId,
                  walletId: walletCheck.id,
                  type: WalletTransactionType.WITHDRAW,
                  status: WalletTransactionStatus.PENDING,
                  amount: amountInSen,
                  balanceBefore: lockedWallet.totalBalance,
                  balanceAfter: lockedWallet.totalBalance - amountInSen,
                  bankAccountId,
                  withdrawStatus: WithdrawStatus.PENDING_OTP,
                  description: `Withdrawal to ${sanitizedBankName} ****${plainAccountNumber.slice(-4)}`,
                },
              });
            },
            {
              isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
              maxWait: 10000,
              timeout: 15000,
            },
          );

          lastError = null;
          break;
        } catch (err: unknown) {
          lastError = err;
          const isRetryable = this.isRetryableDbError(err);
          if (!isRetryable || attempt === MAX_RETRIES) {
            this.logger.error(
              `WITHDRAW_TX_FAILED wallet=${walletCheck.id} user=${userId} attempt=${attempt}/${MAX_RETRIES} retryable=${isRetryable}`,
              err instanceof Error ? err.stack : String(err),
            );
            break;
          }
          this.logger.warn(
            `WITHDRAW_TX_RETRY wallet=${walletCheck.id} user=${userId} attempt=${attempt}/${MAX_RETRIES}`,
          );
          await new Promise(resolve => setTimeout(resolve, 100 * attempt));
        }
      }

      if (lastError) {
        throw lastError;
      }
    } finally {
      await this.redis
        .releaseLock(withdrawLockKey, withdrawLockToken)
        .catch((error: unknown) =>
          this.logger.warn(
            `WITHDRAW lock release failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
    }

    let otp: string;
    try {
      await this.otpService.invalidateOtps(user.email ?? '', OtpType.WITHDRAW_CONFIRMATION);
      otp = await this.otpService.generateOtp(
        user.email ?? '',
        OtpType.WITHDRAW_CONFIRMATION,
        userId,
        { walletTxId, amountSen: amountInSen.toString(), bankAccountId, timestamp: Date.now() },
        ip,
      );
      await this.emailQueue.add(
        'send',
        {
          to: user.email ?? '',
          subject: 'Kahade - Withdrawal Confirmation Code',
          templateName: 'withdrawal-otp',
          templateContext: { otp },
        },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          removeOnFail: 50,
        },
      );
    } catch (otpError) {
      this.logger.error(
        `WITHDRAW_OTP_SETUP_FAILED txId=${walletTxId}; compensating reservation`,
        otpError instanceof Error ? otpError.stack : String(otpError),
      );
      try {
        await this.cancelPendingWithdrawal(userId, walletTxId);
      } catch (compensationError) {
        this.logger.error(
          `CRITICAL: withdrawal reservation compensation failed txId=${walletTxId}: ${compensationError instanceof Error ? compensationError.message : String(compensationError)}`,
        );
      }
      throw otpError;
    }

    await this.redis.setNx(WITHDRAW_OTP_COOLDOWN(userId), '1', 60).catch(cooldownError => {
      this.logger.warn(
        `Withdrawal OTP cooldown could not be recorded for txId=${walletTxId}: ${cooldownError instanceof Error ? cooldownError.message : String(cooldownError)}`,
      );
    });

    this.runRealtimeBestEffort(
      () => this.realtime.emitToUser(userId, 'wallet.balance_updated', { userId }),
      'WITHDRAW_RESERVATION_BALANCE',
    );

    this.auditLog.logUserAction({
      userId,
      action: UserAuditAction.WITHDRAW_REQUESTED,
      entityType: 'WalletTransaction',
      entityId: walletTxId,
      description: `User requested withdrawal of ${amount} to bank account ${bankAccountId}`,
    });

    return {
      withdrawTxId: walletTxId,
      amount,
      bankAccount: { masked: `****${plainAccountNumber.slice(-4)}` },
      otpExpiredAt: new Date(
        Date.now() +
          (this.configService.get<number>('app.otpExpiresMinutes') ?? OTP_EXPIRES_MINUTES) *
            60 *
            1000,
      ),
    };
  }

  async cancelPendingWithdrawal(userId: string, txId: string): Promise<{ message: string }> {
    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet)
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Wallet not found' });

    const walletTx = await this.prisma.walletTransaction.findFirst({
      where: {
        txId,
        walletId: wallet.id,
        type: WalletTransactionType.WITHDRAW,
        status: WalletTransactionStatus.PENDING,
        withdrawStatus: WithdrawStatus.PENDING_OTP,
      },
    });
    if (!walletTx) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'No pending withdrawal found with this ID',
      });
    }

    const cancelLockKey = WALLET_LOCK(userId);
    const cancelLockToken = `cancel:${Date.now()}:${randomBytes(16).toString('hex')}`;
    const cancelLockAcquired = await this.redis.setNx(
      cancelLockKey,
      cancelLockToken,
      WITHDRAW_LIFECYCLE_LOCK_TTL_SECONDS,
    );
    if (!cancelLockAcquired) {
      throw new ConflictException({
        code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
        message: 'Another wallet operation is in progress. Please try again.',
      });
    }

    try {
      let cancelLastError: unknown;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await this.prisma.$transaction(
            async (tx: Prisma.TransactionClient) => {
              const freshWithdrawal = await tx.walletTransaction.findFirst({
                where: {
                  id: walletTx.id,
                  walletId: wallet.id,
                  type: WalletTransactionType.WITHDRAW,
                  status: WalletTransactionStatus.PENDING,
                  withdrawStatus: WithdrawStatus.PENDING_OTP,
                },
                select: { id: true, amount: true, createdAt: true },
              });
              if (!freshWithdrawal) {
                throw new ConflictException({
                  code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                  message: 'Withdrawal already processed or cancelled',
                });
              }
              const claimed = await tx.walletTransaction.updateMany({
                where: {
                  id: freshWithdrawal.id,
                  type: WalletTransactionType.WITHDRAW,
                  status: WalletTransactionStatus.PENDING,
                  withdrawStatus: WithdrawStatus.PENDING_OTP,
                },
                data: {
                  withdrawStatus: WithdrawStatus.FAILED,
                  status: WalletTransactionStatus.FAILED,
                },
              });
              if (claimed.count === 0) {
                throw new ConflictException({
                  code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                  message: 'Withdrawal already processed or cancelled',
                });
              }

              const todayStartWib = startOfDayWIB();
              const isToday = freshWithdrawal.createdAt >= todayStartWib;

              const freshWallet = await tx.$queryRaw<
                { id: string; version: number; isLocked: boolean }[]
              >`
              SELECT id, version, "isLocked" FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
              if (!freshWallet.length) {
                throw new ConflictException({
                  code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                  message: 'Wallet not found',
                });
              }

              if (freshWallet[0].isLocked) {
                throw new ForbiddenException({
                  code: ErrorCodes.WALLET_LOCKED,
                  message: 'Wallet is locked and cannot refund a pending withdrawal',
                });
              }
              const walletUpdate = await tx.wallet.updateMany({
                where: { id: wallet.id, version: freshWallet[0].version },
                data: {
                  availableBalance: { increment: freshWithdrawal.amount },
                  totalBalance: { increment: freshWithdrawal.amount },
                  ...(isToday
                    ? { todayWithdrawAmount: { decrement: freshWithdrawal.amount } }
                    : {}),
                  version: { increment: 1 },
                },
              });
              if (walletUpdate.count === 0) {
                throw new ConflictException({
                  code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                  message: 'Wallet was modified concurrently, please retry',
                });
              }
            },
            {
              isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
              maxWait: 10000,
              timeout: 15000,
            },
          );
          cancelLastError = null;
          break;
        } catch (err: unknown) {
          cancelLastError = err;
          if (!this.isRetryableDbError(err) || attempt === 3) break;
          this.logger.warn(
            `CANCEL_WITHDRAW_TX_RETRY wallet=${wallet.id} txId=${txId} attempt=${attempt}/3`,
          );
          await new Promise(resolve => setTimeout(resolve, 100 * attempt));
        }
      }
      if (cancelLastError) throw cancelLastError;
    } finally {
      await this.redis
        .releaseLock(cancelLockKey, cancelLockToken)
        .catch(err =>
          this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`),
        );
    }

    this.runRealtimeBestEffort(
      () => this.realtime.emitToUser(userId, 'wallet.balance_updated', { userId }),
      'CANCEL_WITHDRAW_BALANCE',
    );
    this.auditLog.logUserAction({
      userId,
      action: UserAuditAction.WITHDRAW_CANCELLED,
      entityType: 'WalletTransaction',
      entityId: txId,
      description: `User cancelled pending withdrawal ${txId}`,
    });

    return { message: 'Pending withdrawal cancelled and funds restored' };
  }

  async transfer(
    senderId: string,
    recipientId: string,
    amount: number,
    pin: string,
    note?: string,
    ip?: string,
  ): Promise<Record<string, unknown>> {
    if (senderId === recipientId) {
      throw new BadRequestException({
        code: ErrorCodes.CANNOT_TRANSFER_SELF,
        message: 'Cannot transfer to yourself',
      });
    }

    const [sender, recipient] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: senderId },
        select: {
          id: true,
          userId: true,
          fullName: true,
          email: true,
          kycStatus: true,
          isActive: true,
          isBanned: true,
          deletedAt: true,
        },
      }),
      this.prisma.user.findFirst({
        where: {
          OR: [{ id: recipientId }, { userId: recipientId }, { username: recipientId }],
          deletedAt: null,
        },
        select: {
          id: true,
          userId: true,
          fullName: true,
          username: true,
          email: true,
          kycStatus: true,
          isActive: true,
          isBanned: true,
        },
      }),
    ]);

    if (!sender)
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Sender not found' });
    if (!sender.isActive || sender.isBanned || sender.deletedAt != null) {
      throw new ForbiddenException({
        code: ErrorCodes.ACCOUNT_INACTIVE,
        message: 'Sender account is not active',
      });
    }
    if (!recipient)
      throw new NotFoundException({
        code: ErrorCodes.RECIPIENT_NOT_FOUND,
        message: 'Recipient not found',
      });
    if (!recipient.isActive || recipient.isBanned) {
      throw new BadRequestException({
        code: ErrorCodes.RECIPIENT_NOT_FOUND,
        message: 'Recipient account is not active',
      });
    }
    if (sender.id === recipient.id) {
      throw new BadRequestException({
        code: ErrorCodes.CANNOT_TRANSFER_SELF,
        message: 'Cannot transfer to yourself',
      });
    }

    if (sender.kycStatus !== KycStatus.APPROVED) {
      throw new ForbiddenException({
        code: ErrorCodes.SENDER_KYC_REQUIRED,
        message: 'KYC verification is required before sending transfers',
      });
    }
    const senderWallet = await this.prisma.wallet.findUnique({ where: { userId: sender.id } });
    if (!senderWallet)
      throw new NotFoundException({
        code: ErrorCodes.WALLET_NOT_FOUND,
        message: 'Sender wallet not found',
      });
    if (senderWallet.isLocked)
      throw new ForbiddenException({
        code: ErrorCodes.WALLET_LOCKED,
        message: 'Your wallet is locked',
      });

    const recipientWallet = await this.prisma.wallet.findUnique({
      where: { userId: recipient.id },
    });
    if (!recipientWallet)
      throw new NotFoundException({
        code: ErrorCodes.RECIPIENT_NOT_FOUND,
        message: 'Recipient wallet not found',
      });
    if (recipientWallet.isLocked)
      throw new ForbiddenException({
        code: ErrorCodes.RECIPIENT_WALLET_LOCKED,
        message: 'Recipient wallet is currently locked',
      });

    if (
      !Number.isFinite(amount) ||
      !Number.isInteger(amount) ||
      amount <= 0 ||
      amount > Number.MAX_SAFE_INTEGER / 100
    ) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message:
          'Transfer amount must be a finite positive whole IDR amount within the supported range',
      });
    }
    const amountInSen = toSen(amount);
    const minTransfer = toSen(WALLET_MIN_TRANSFER);
    const maxTransfer = toSen(WALLET_MAX_TRANSFER_PER_TX);

    if (amountInSen < minTransfer) {
      throw new BadRequestException({
        code: ErrorCodes.BELOW_MINIMUM_TRANSFER,
        message: `Minimum transfer is Rp ${WALLET_MIN_TRANSFER.toLocaleString('id-ID')}`,
      });
    }
    if (amountInSen > maxTransfer) {
      throw new BadRequestException({
        code: ErrorCodes.ABOVE_MAXIMUM_TRANSFER,
        message: `Maximum per-transaction transfer is Rp ${WALLET_MAX_TRANSFER_PER_TX.toLocaleString('id-ID')}`,
      });
    }

    // Validate cheap deterministic constraints before bcrypt/PIN attempt counters so an invalid
    // amount cannot consume a user's security budget or trigger a PIN cooldown.
    await this.verifyWalletPin(senderWallet, pin, sender.id, ip);

    const transferLockKey = TRANSFER_LOCK(sender.id);
    const transferLockToken = `transfer:${Date.now()}:${randomBytes(16).toString('hex')}`;
    const lockAcquired = await this.redis.setNx(transferLockKey, transferLockToken, 30);
    if (!lockAcquired) {
      throw new ConflictException({
        code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
        message: 'Another wallet operation is in progress. Please try again.',
      });
    }

    const safeNote =
      typeof note === 'string'
        ? note
            .replace(/[\u0000-\u001F\u007F]/g, ' ')
            .trim()
            .slice(0, 200)
        : '';
    const safeRecipientName = recipient.fullName
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .trim()
      .slice(0, 120);
    const safeSenderName = sender.fullName
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .trim()
      .slice(0, 120);
    const description = safeNote
      ? `Transfer to ${safeRecipientName}: ${safeNote}`
      : `Transfer to ${safeRecipientName}`;
    const receiveDescription = safeNote
      ? `Transfer from ${safeSenderName}: ${safeNote}`
      : `Transfer from ${safeSenderName}`;

    let sentTxId: string;
    let receivedTxId: string;

    try {
      const today = formatWIBDate();
      const dailyKey = DAILY_TRANSFER_AMOUNT(sender.id, today);
      const dailyLimitSen = toSen(WALLET_DAILY_TRANSFER_LIMIT);

      const amountAsNumber = Number(amountInSen);
      if (!Number.isSafeInteger(amountAsNumber)) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: `Transfer amount exceeds safe integer range for daily counter`,
        });
      }
      const newDailyTotal = await this.redis.incrBy(dailyKey, amountAsNumber);
      const ttlExists = await this.redis.ttl(dailyKey);
      if (ttlExists < 0) {
        const nowMs = Date.now();
        const ttlSec = Math.max(
          Math.ceil((endOfDayWIB(new Date(nowMs)).getTime() - nowMs) / 1000),
          60,
        );
        try {
          await this.redis.expire(dailyKey, ttlSec);
        } catch (ttlError) {
          await this.redis
            .decrBy(dailyKey, amountAsNumber)
            .catch(rollbackError =>
              this.logger.error(
                `Failed to rollback daily transfer counter after TTL setup failure: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
              ),
            );
          throw ttlError;
        }
      }

      if (BigInt(newDailyTotal) > dailyLimitSen) {
        await this.redis
          .decrBy(dailyKey, amountAsNumber)
          .catch(err =>
            this.logger.error(`Failed to rollback daily transfer counter: ${err.message}`),
          );
        throw new BadRequestException({
          code: ErrorCodes.DAILY_TRANSFER_LIMIT_EXCEEDED,
          message: `Daily transfer limit of Rp ${WALLET_DAILY_TRANSFER_LIMIT.toLocaleString('id-ID')} exceeded`,
        });
      }

      let dailyCounterRolledBack = false;

      try {
        const sentSerial = await this.getNextWalletTxSerial();
        const receivedSerial = await this.getNextWalletTxSerial();
        sentTxId = generateWalletTxId(sentSerial);
        receivedTxId = generateWalletTxId(receivedSerial);
      } catch (serialError: unknown) {
        dailyCounterRolledBack = true;
        await this.redis
          .decrBy(dailyKey, amountAsNumber)
          .catch(rollbackError =>
            this.logger.error(
              `Failed to rollback daily transfer counter after serial allocation failure: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
            ),
          );
        throw serialError;
      }

      const MAX_RETRIES = 3;
      let lastError: unknown;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await this.prisma.$transaction(
            async (tx: Prisma.TransactionClient) => {
              const [firstId, secondId] = [senderWallet.id, recipientWallet.id].sort();
              await tx.$queryRaw`SELECT id FROM wallets WHERE id IN (${firstId}, ${secondId}) ORDER BY id FOR UPDATE`;

              const senderLocked = await tx.wallet.findUnique({ where: { id: senderWallet.id } });
              if (!senderLocked)
                throw new NotFoundException({
                  code: ErrorCodes.WALLET_NOT_FOUND,
                  message: 'Sender wallet not found',
                });
              if (senderLocked.isLocked)
                throw new ForbiddenException({
                  code: ErrorCodes.WALLET_LOCKED,
                  message: 'Your wallet is locked',
                });
              if (senderLocked.availableBalance < amountInSen) {
                throw new BadRequestException({
                  code: ErrorCodes.INSUFFICIENT_BALANCE,
                  message: 'Insufficient balance for transfer',
                });
              }

              const recipientLocked = await tx.wallet.findUnique({
                where: { id: recipientWallet.id },
              });
              if (!recipientLocked)
                throw new NotFoundException({
                  code: ErrorCodes.RECIPIENT_NOT_FOUND,
                  message: 'Recipient wallet not found',
                });
              if (recipientLocked.isLocked)
                throw new ForbiddenException({
                  code: ErrorCodes.RECIPIENT_WALLET_LOCKED,
                  message: 'Recipient wallet is currently locked',
                });

              const senderUpdated = await tx.wallet.updateMany({
                where: {
                  id: senderWallet.id,
                  version: senderLocked.version,
                  availableBalance: { gte: amountInSen },
                },
                data: {
                  availableBalance: { decrement: amountInSen },
                  totalBalance: { decrement: amountInSen },
                  version: { increment: 1 },
                },
              });
              if (senderUpdated.count === 0) {
                throw new ConflictException({
                  code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                  message: 'Concurrent update detected, please retry',
                });
              }

              const recipientUpdated = await tx.wallet.updateMany({
                where: { id: recipientWallet.id, version: recipientLocked.version },
                data: {
                  availableBalance: { increment: amountInSen },
                  totalBalance: { increment: amountInSen },
                  version: { increment: 1 },
                },
              });
              if (recipientUpdated.count === 0) {
                throw new ConflictException({
                  code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                  message: 'Concurrent update on recipient wallet detected, please retry',
                });
              }

              await tx.walletTransaction.create({
                data: {
                  txId: sentTxId,
                  walletId: senderWallet.id,
                  type: WalletTransactionType.TRANSFER_SENT,
                  status: WalletTransactionStatus.SUCCESS,
                  amount: amountInSen,
                  balanceBefore: senderLocked.availableBalance,
                  balanceAfter: senderLocked.availableBalance - amountInSen,
                  description,
                  metadata: {
                    recipientId: recipient.id,
                    recipientUserId: recipient.userId,
                    recipientName: recipient.fullName,
                    note: note || null,
                    linkedTxId: receivedTxId,
                  },
                },
              });

              await tx.walletTransaction.create({
                data: {
                  txId: receivedTxId,
                  walletId: recipientWallet.id,
                  type: WalletTransactionType.TRANSFER_RECEIVED,
                  status: WalletTransactionStatus.SUCCESS,
                  amount: amountInSen,
                  balanceBefore: recipientLocked.availableBalance,
                  balanceAfter: recipientLocked.availableBalance + amountInSen,
                  description: receiveDescription,
                  metadata: {
                    senderId: sender.id,
                    senderUserId: sender.userId,
                    senderName: sender.fullName,
                    note: note || null,
                    linkedTxId: sentTxId,
                  },
                },
              });
            },
            {
              isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
              maxWait: 10000,
              timeout: 15000,
            },
          );

          lastError = null;
          break;
        } catch (err: unknown) {
          lastError = err;
          const isRetryable = this.isRetryableDbError(err);
          if (!isRetryable || attempt === MAX_RETRIES) {
            this.logger.error(
              `TRANSFER_TX_FAILED sender=${sender.userId} recipient=${recipient.userId} attempt=${attempt}/${MAX_RETRIES} retryable=${isRetryable}`,
              err instanceof Error ? err.stack : String(err),
            );
            break;
          }
          this.logger.warn(
            `TRANSFER_TX_RETRY sender=${sender.userId} recipient=${recipient.userId} attempt=${attempt}/${MAX_RETRIES}`,
          );
          const jitter = randomInt(0, 50);
          await new Promise(resolve =>
            setTimeout(resolve, 100 * Math.pow(2, attempt - 1) + jitter),
          );
        }
      }

      if (lastError) {
        if (!dailyCounterRolledBack) {
          dailyCounterRolledBack = true;
          await this.redis
            .decrBy(dailyKey, amountAsNumber)
            .catch(err =>
              this.logger.error(
                `Failed to rollback daily transfer counter after DB failure: ${err.message}`,
              ),
            );
        }
        throw lastError;
      }

      // Money movement is already committed; notification persistence is best-effort and
      // must never roll back or mask a successful transfer.
      this.prisma.notification
        .createMany({
          data: [
            {
              notifId: generateNotifId(),
              userId: sender.id,
              type: NotificationType.WALLET_TRANSFER_SENT,
              category: getCategoryForType(NotificationType.WALLET_TRANSFER_SENT),
              title: 'Transfer Terkirim',
              body: `Anda mengirim Rp ${amount.toLocaleString('id-ID')} ke ${recipient.fullName}`,
              metadata: { txId: sentTxId, amount, recipientName: recipient.fullName },
            },
            {
              notifId: generateNotifId(),
              userId: recipient.id,
              type: NotificationType.WALLET_TRANSFER_RECEIVED,
              category: getCategoryForType(NotificationType.WALLET_TRANSFER_RECEIVED),
              title: 'Transfer Diterima',
              body: `Anda menerima Rp ${amount.toLocaleString('id-ID')} dari ${sender.fullName}`,
              metadata: { txId: receivedTxId, amount, senderName: sender.fullName },
            },
          ],
        })
        .catch((err: unknown) =>
          this.logger.warn(
            `silent-catch: transfer notification failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );

      this.runRealtimeBestEffort(
        () => this.realtime.emitToUser(sender.id, 'wallet.balance_updated', { userId: sender.id }),
        'TRANSFER_SENDER_BALANCE',
      );
      this.runRealtimeBestEffort(
        () =>
          this.realtime.emitToUser(recipient.id, 'wallet.balance_updated', {
            userId: recipient.id,
          }),
        'TRANSFER_RECIPIENT_BALANCE',
      );
      this.runRealtimeBestEffort(
        () =>
          this.realtime.emitToUser(recipient.id, 'notification.new', {
            type: 'WALLET_TRANSFER_RECEIVED',
          }),
        'TRANSFER_NOTIFICATION_PUSH',
      );

      this.auditLog.logUserAction({
        userId: sender.id,
        action: UserAuditAction.TRANSFER_SENT,
        entityType: 'wallet',
        entityId: sentTxId!,
        description: `Transfer sent Rp ${amount} to ${recipient.userId}`,
        after: {
          amount,
          recipientId: recipient.id,
          recipientUserId: recipient.userId,
          txId: sentTxId,
        },
        ipAddress: ip,
      });
      this.auditLog.logUserAction({
        userId: recipient.id,
        action: UserAuditAction.TRANSFER_RECEIVED,
        entityType: 'wallet',
        entityId: receivedTxId!,
        description: `Transfer received Rp ${amount} from ${sender.userId}`,
        after: { amount, senderId: sender.id, senderUserId: sender.userId, txId: receivedTxId },
      });

      const sanitizeName = (n: string | null) => (n ?? '').replace(/[<>&"']/g, '').slice(0, 100);
      void Promise.resolve()
        .then(() =>
          this.emailQueue.add('send', {
            to: sender.email ?? '',
            subject: `Transfer Berhasil - Rp ${amount.toLocaleString('id-ID')}`,
            templateName: 'transfer-sent',
            templateContext: {
              name: sanitizeName(sender.fullName),
              amount: `Rp ${amount.toLocaleString('id-ID')}`,
              recipientName: sanitizeName(recipient.fullName),
              txId: sentTxId,
              date: new Date().toLocaleDateString('id-ID'),
            },
          }),
        )
        .catch(err =>
          this.logger.warn(
            `Failed to queue transfer email: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );

      void Promise.resolve()
        .then(() =>
          this.emailQueue.add('send', {
            to: recipient.email ?? '',
            subject: `Transfer Diterima - Rp ${amount.toLocaleString('id-ID')}`,
            templateName: 'transfer-received',
            templateContext: {
              name: sanitizeName(recipient.fullName),
              amount: `Rp ${amount.toLocaleString('id-ID')}`,
              senderName: sanitizeName(sender.fullName),
              txId: receivedTxId,
              date: new Date().toLocaleDateString('id-ID'),
            },
          }),
        )
        .catch(err =>
          this.logger.warn(
            `Failed to queue transfer email: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );

      this.logger.log(
        `TRANSFER_SUCCESS sender=${sender.userId} recipient=${recipient.userId} amount=${amount} sentTx=${sentTxId} receivedTx=${receivedTxId}`,
      );
    } finally {
      try {
        await this.redis.releaseLock(transferLockKey, transferLockToken);
      } catch (error: unknown) {
        this.logger.warn(
          `TRANSFER lock release failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return {
      message: 'Transfer successful',
      txId: sentTxId!,
      amount,
      recipient: {
        userId: recipient.userId,
        fullName: recipient.fullName,
        username: recipient.username,
      },
    };
  }

  async lookupTransferRecipient(
    query: string,
    senderId: string,
  ): Promise<Record<string, unknown> | null> {
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ username: query }, { userId: query }],
        deletedAt: null,
        isActive: true,
        isBanned: false,
        id: { not: senderId },
      },
      select: { id: true, userId: true, fullName: true, username: true, avatarUrl: true },
    });

    if (!user) return null;

    return {
      id: user.id,
      userId: user.userId,
      fullName: user.fullName,
      username: user.username,
      avatarUrl: user.avatarUrl,
    };
  }

  async lockEscrowForOrder(walletId: string, amount: bigint, orderId: string): Promise<string> {
    if (amount <= BigInt(0)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Escrow lock amount must be greater than zero',
      });
    }
    let walletTxSerial: number | null = null;
    let walletTxId!: string;
    await this.withWalletSerializableRetry(
      () =>
        this.prisma.$transaction(
          async (tx: Prisma.TransactionClient) => {
            const existingLock = await tx.walletTransaction.findFirst({
              where: {
                orderId,
                walletId,
                type: WalletTransactionType.ORDER_LOCK,
                status: WalletTransactionStatus.SUCCESS,
              },
              select: { txId: true, amount: true },
            });
            if (existingLock) {
              if (existingLock.amount !== amount) {
                throw new ConflictException({
                  code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                  message: 'Existing escrow lock amount differs from requested amount',
                });
              }
              walletTxId = existingLock.txId;
              return;
            }

            await tx.$queryRaw`SELECT id FROM wallets WHERE id = ${walletId} FOR UPDATE`;

            const wallet = await tx.wallet.findUnique({ where: { id: walletId } });

            if (!wallet) {
              throw new NotFoundException({
                code: ErrorCodes.NOT_FOUND,
                message: 'Wallet not found',
              });
            }
            if (wallet.isLocked) {
              throw new ForbiddenException({
                code: ErrorCodes.WALLET_LOCKED,
                message: 'Wallet is locked and cannot fund escrow',
              });
            }
            if (wallet.availableBalance < amount) {
              this.logger.warn(
                `ESCROW_LOCK_REJECTED wallet=${walletId} order=${orderId} reason=insufficient_balance amount=${amount} available=${wallet.availableBalance}`,
              );
              throw new BadRequestException({
                code: ErrorCodes.INSUFFICIENT_BALANCE,
                message: 'Insufficient available balance for escrow',
              });
            }

            const updated = await tx.wallet.updateMany({
              where: { id: walletId, version: wallet.version, availableBalance: { gte: amount } },
              data: {
                availableBalance: { decrement: amount },
                escrowBalance: { increment: amount },
                version: { increment: 1 },
              },
            });

            if (updated.count === 0) {
              throw new ConflictException({
                code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                message: 'Concurrent update detected, please retry',
              });
            }

            const verifiedWallet = await tx.wallet.findUnique({
              where: { id: walletId },
              select: { availableBalance: true, escrowBalance: true },
            });
            if (verifiedWallet) {
              const expectedAvailable = wallet.availableBalance - amount;
              const expectedEscrow = wallet.escrowBalance + amount;
              if (
                verifiedWallet.availableBalance !== expectedAvailable ||
                verifiedWallet.escrowBalance !== expectedEscrow
              ) {
                this.logger.error(
                  `POST-TX BALANCE MISMATCH [escrow-lock] wallet=${walletId}: ` +
                    `expected available=${expectedAvailable} escrow=${expectedEscrow}, ` +
                    `actual available=${verifiedWallet.availableBalance} escrow=${verifiedWallet.escrowBalance}`,
                );
                throw new ConflictException({
                  code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                  message: 'Post-transaction balance verification failed',
                });
              }
            }

            if (walletTxSerial === null) walletTxSerial = await this.getNextWalletTxSerial();
            walletTxId = generateWalletTxId(walletTxSerial);
            await tx.walletTransaction.create({
              data: {
                txId: walletTxId,
                walletId,
                type: WalletTransactionType.ORDER_LOCK,
                status: WalletTransactionStatus.SUCCESS,
                amount,
                balanceBefore: wallet.availableBalance,
                balanceAfter: wallet.availableBalance - amount,
                orderId,
                description: `Escrow lock for order ${orderId}`,
              },
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      'LOCK_ESCROW',
    );

    const lockedWalletUser = await this.prisma.wallet.findUnique({
      where: { id: walletId },
      select: { userId: true },
    });
    if (lockedWalletUser) {
      this.runRealtimeBestEffort(
        () =>
          this.realtime.emitToUser(lockedWalletUser.userId, 'wallet.balance_updated', {
            userId: lockedWalletUser.userId,
          }),
        'LOCK_ESCROW_BALANCE',
      );
    }

    return walletTxId;
  }

  async releaseEscrow(
    fromWalletId: string,
    toWalletId: string,
    amount: bigint,
    orderId: string,
  ): Promise<void> {
    if (amount <= BigInt(0)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Escrow release amount must be greater than zero',
      });
    }
    let releaseTxSerial: number | null = null;
    let receiveTxSerial: number | null = null;
    await this.withWalletSerializableRetry(
      () =>
        this.prisma.$transaction(
          async (tx: Prisma.TransactionClient) => {
            const existingRelease = await tx.walletTransaction.findFirst({
              where: {
                orderId,
                walletId: fromWalletId,
                type: WalletTransactionType.ORDER_RELEASE,
                status: WalletTransactionStatus.SUCCESS,
              },
              select: { txId: true, amount: true },
            });
            const existingReceive = await tx.walletTransaction.findFirst({
              where: {
                orderId,
                walletId: toWalletId,
                type: WalletTransactionType.ORDER_RELEASE,
                status: WalletTransactionStatus.SUCCESS,
              },
              select: { txId: true, amount: true },
            });
            if (existingRelease || existingReceive) {
              if (
                !existingRelease ||
                !existingReceive ||
                existingRelease.amount !== amount ||
                existingReceive.amount !== amount
              ) {
                throw new ConflictException({
                  code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                  message: 'Escrow release ledger pair is incomplete or has a different amount',
                });
              }
              return;
            }

            // Acquire locks in a deterministic order (sorted IDs) to prevent deadlocks when two
            // concurrent releases involve the same pair of wallets in opposite directions.
            const [firstId, secondId] = [fromWalletId, toWalletId].sort();
            await tx.$queryRaw`SELECT id FROM wallets WHERE id IN (${firstId}, ${secondId}) ORDER BY id FOR UPDATE`;

            const fromWallet = await tx.wallet.findUnique({ where: { id: fromWalletId } });

            if (!fromWallet) {
              throw new NotFoundException({
                code: ErrorCodes.NOT_FOUND,
                message: 'Source wallet not found',
              });
            }
            if (fromWallet.isLocked) {
              throw new ForbiddenException({
                code: ErrorCodes.WALLET_LOCKED,
                message: 'Source wallet is locked',
              });
            }
            if (fromWallet.escrowBalance < amount) {
              throw new BadRequestException({
                code: ErrorCodes.INSUFFICIENT_BALANCE,
                message: 'Insufficient escrow balance',
              });
            }

            const toWallet = await tx.wallet.findUnique({ where: { id: toWalletId } });

            if (!toWallet) {
              throw new NotFoundException({
                code: ErrorCodes.NOT_FOUND,
                message: 'Destination wallet not found',
              });
            }
            if (toWallet.isLocked) {
              throw new ForbiddenException({
                code: ErrorCodes.RECIPIENT_WALLET_LOCKED,
                message: 'Destination wallet is locked',
              });
            }
            if (releaseTxSerial === null) releaseTxSerial = await this.getNextWalletTxSerial();
            if (receiveTxSerial === null) receiveTxSerial = await this.getNextWalletTxSerial();
            const updated = await tx.wallet.updateMany({
              where: {
                id: fromWalletId,
                version: fromWallet.version,
                escrowBalance: { gte: amount },
              },
              data: {
                escrowBalance: { decrement: amount },
                totalBalance: { decrement: amount },
                version: { increment: 1 },
              },
            });

            if (updated.count === 0) {
              throw new ConflictException({
                code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                message: 'Concurrent escrow release detected, please retry',
              });
            }

            const toUpdated = await tx.wallet.updateMany({
              where: { id: toWalletId, version: toWallet.version },
              data: {
                availableBalance: { increment: amount },
                totalBalance: { increment: amount },
                version: { increment: 1 },
              },
            });
            if (toUpdated.count === 0) {
              throw new ConflictException({
                code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                message: 'Concurrent update on destination wallet detected, please retry',
              });
            }

            const verifiedFrom = await tx.wallet.findUnique({
              where: { id: fromWalletId },
              select: { escrowBalance: true, totalBalance: true },
            });
            const verifiedTo = await tx.wallet.findUnique({
              where: { id: toWalletId },
              select: { availableBalance: true, totalBalance: true },
            });
            if (verifiedFrom) {
              const expectedEscrow = fromWallet.escrowBalance - amount;
              const expectedTotal = fromWallet.totalBalance - amount;
              if (
                verifiedFrom.escrowBalance !== expectedEscrow ||
                verifiedFrom.totalBalance !== expectedTotal
              ) {
                this.logger.error(
                  `POST-TX BALANCE MISMATCH [escrow-release-from] wallet=${fromWalletId}: ` +
                    `expected escrow=${expectedEscrow} total=${expectedTotal}, ` +
                    `actual escrow=${verifiedFrom.escrowBalance} total=${verifiedFrom.totalBalance}`,
                );
                throw new ConflictException({
                  code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                  message: 'Post-transaction balance verification failed',
                });
              }
            }
            if (verifiedTo) {
              const expectedAvailable = toWallet.availableBalance + amount;
              const expectedTotal = toWallet.totalBalance + amount;
              if (
                verifiedTo.availableBalance !== expectedAvailable ||
                verifiedTo.totalBalance !== expectedTotal
              ) {
                this.logger.error(
                  `POST-TX BALANCE MISMATCH [escrow-release-to] wallet=${toWalletId}: ` +
                    `expected available=${expectedAvailable} total=${expectedTotal}, ` +
                    `actual available=${verifiedTo.availableBalance} total=${verifiedTo.totalBalance}`,
                );
                throw new ConflictException({
                  code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                  message: 'Post-transaction balance verification failed',
                });
              }
            }

            const releaseTxId = generateWalletTxId(releaseTxSerial);
            await tx.walletTransaction.create({
              data: {
                txId: releaseTxId,
                walletId: fromWalletId,
                type: WalletTransactionType.ORDER_RELEASE,
                status: WalletTransactionStatus.SUCCESS,
                amount,
                balanceBefore: fromWallet.totalBalance,
                balanceAfter: fromWallet.totalBalance - amount,
                orderId,
                description: `Escrow release from order ${orderId}`,
              },
            });

            const receiveTxId = generateWalletTxId(receiveTxSerial);
            await tx.walletTransaction.create({
              data: {
                txId: receiveTxId,
                walletId: toWalletId,
                type: WalletTransactionType.ORDER_RELEASE,
                status: WalletTransactionStatus.SUCCESS,
                amount,
                balanceBefore: toWallet.totalBalance,
                balanceAfter: toWallet.totalBalance + amount,
                orderId,
                description: `Escrow received from order ${orderId}`,
              },
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      'RELEASE_ESCROW',
    );

    const [fromUser, toUser] = await Promise.all([
      this.prisma.wallet.findUnique({ where: { id: fromWalletId }, select: { userId: true } }),
      this.prisma.wallet.findUnique({ where: { id: toWalletId }, select: { userId: true } }),
    ]);
    if (fromUser)
      this.runRealtimeBestEffort(
        () =>
          this.realtime.emitToUser(fromUser.userId, 'wallet.balance_updated', {
            userId: fromUser.userId,
          }),
        'RELEASE_ESCROW_SOURCE_BALANCE',
      );
    if (toUser)
      this.runRealtimeBestEffort(
        () =>
          this.realtime.emitToUser(toUser.userId, 'wallet.balance_updated', {
            userId: toUser.userId,
          }),
        'RELEASE_ESCROW_DESTINATION_BALANCE',
      );
  }

  async handleTopupSuccess(midtransOrderId: string, webhookGrossAmount?: string): Promise<void> {
    const paymentTx = await this.prisma.paymentTransaction.findUnique({
      where: { midtransOrderId },
    });
    if (!paymentTx || paymentTx.status !== PaymentStatus.PENDING) return; // idempotency guard

    if (webhookGrossAmount !== undefined) {
      const webhookAmountSen = this.parseProviderAmountToSen(webhookGrossAmount, 'gross_amount');
      const expectedGross =
        paymentTx.grossAmount > BigInt(0) ? paymentTx.grossAmount : paymentTx.amount;
      if (webhookAmountSen !== expectedGross) {
        this.logger.error(
          `CRITICAL: Webhook amount mismatch for ${midtransOrderId}. ` +
            `Webhook: ${webhookGrossAmount} (${webhookAmountSen} sen), DB grossAmount: ${expectedGross} sen. ` +
            `Rejecting credit to prevent fraud.`,
        );
        throw new BadRequestException({
          code: 'AMOUNT_MISMATCH',
          message: 'Webhook gross_amount does not match stored transaction amount',
        });
      }
    }

    let walletTxSerial: number | null = null;

    const topupSettled = await this.withWalletSerializableRetry(
      () =>
        this.prisma.$transaction(
          async (tx: Prisma.TransactionClient) => {
            const claimed = await tx.paymentTransaction.updateMany({
              where: { midtransOrderId, status: PaymentStatus.PENDING },
              data: { status: PaymentStatus.SUCCESS, settledAt: new Date() },
            });
            if (claimed.count === 0) {
              return false;
            }

            await tx.$queryRaw`SELECT id FROM wallets WHERE "userId" = ${paymentTx.userId} FOR UPDATE`;
            const wallet = await tx.wallet.findUnique({ where: { userId: paymentTx.userId } });
            if (!wallet) {
              throw new NotFoundException({
                code: ErrorCodes.NOT_FOUND,
                message: 'Wallet not found during top-up settlement',
              });
            }

            const amount = paymentTx.amount;

            const walletUpdated = await tx.wallet.updateMany({
              where: { id: wallet.id, version: wallet.version },
              data: {
                availableBalance: { increment: amount },
                totalBalance: { increment: amount },
                lastTopupAt: new Date(),
                version: { increment: 1 },
              },
            });
            if (walletUpdated.count === 0) {
              throw new ConflictException({
                code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                message: 'Concurrent wallet update detected, please retry',
              });
            }

            const verifiedWallet = await tx.wallet.findUnique({
              where: { id: wallet.id },
              select: { availableBalance: true, totalBalance: true },
            });
            if (verifiedWallet) {
              const expectedAvailable = wallet.availableBalance + amount;
              const expectedTotal = wallet.totalBalance + amount;
              if (
                verifiedWallet.availableBalance !== expectedAvailable ||
                verifiedWallet.totalBalance !== expectedTotal
              ) {
                this.logger.error(
                  `POST-TX BALANCE MISMATCH [topup] wallet=${wallet.id}: ` +
                    `expected available=${expectedAvailable} total=${expectedTotal}, ` +
                    `actual available=${verifiedWallet.availableBalance} total=${verifiedWallet.totalBalance}`,
                );
                throw new ConflictException({
                  code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                  message: 'Post-transaction balance verification failed',
                });
              }
            }

            const pendingWalletTx = await tx.walletTransaction.findFirst({
              where: {
                paymentTxId: paymentTx.id,
                type: WalletTransactionType.TOP_UP,
                status: WalletTransactionStatus.PENDING,
              },
            });

            if (pendingWalletTx) {
              await tx.walletTransaction.update({
                where: { id: pendingWalletTx.id },
                data: {
                  status: WalletTransactionStatus.SUCCESS,
                  balanceBefore: wallet.totalBalance,
                  balanceAfter: wallet.totalBalance + amount,
                },
              });
            } else {
              if (walletTxSerial === null) walletTxSerial = await this.getNextWalletTxSerial();
              const walletTxId = generateWalletTxId(walletTxSerial);
              await tx.walletTransaction.create({
                data: {
                  txId: walletTxId,
                  walletId: wallet.id,
                  type: WalletTransactionType.TOP_UP,
                  status: WalletTransactionStatus.SUCCESS,
                  amount,
                  balanceBefore: wallet.totalBalance,
                  balanceAfter: wallet.totalBalance + amount,
                  paymentTxId: paymentTx.id,
                  description: 'Top up settlement',
                },
              });
            }

            return true;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      'TOPUP_SUCCESS',
    );

    if (!topupSettled) return;

    const topupNotifTitle = 'Top-up Successful';
    const topupNotifBody = `Top-up of Rp ${toIdr(paymentTx.amount).toLocaleString('id-ID')} has been credited to your wallet.`;
    this.prisma.notification
      .create({
        data: {
          notifId: generateNotifId(),
          userId: paymentTx.userId,
          type: NotificationType.WALLET_TOPUP_SUCCESS,
          category: getCategoryForType(NotificationType.WALLET_TOPUP_SUCCESS),
          title: topupNotifTitle,
          body: topupNotifBody,
          isRead: false,
        },
      })
      .catch((notificationError: unknown) =>
        this.logger.warn(
          `silent-catch: top-up success notification failed: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}`,
        ),
      );
    try {
      this.prisma.emitNotificationCreated({
        userId: paymentTx.userId,
        title: topupNotifTitle,
        body: topupNotifBody,
        data: { type: 'WALLET_TOPUP' },
      });
    } catch (error: unknown) {
      this.logger.warn(
        `Top-up success realtime notification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    this.runRealtimeBestEffort(
      () =>
        this.realtime.emitToUser(paymentTx.userId, 'wallet.balance_updated', {
          userId: paymentTx.userId,
        }),
      'TOPUP_BALANCE',
    );

    this.reconcileDailyTopups(paymentTx.userId).catch(err => {
      this.logger.warn(
        `Daily topup reconciliation check failed for user ${paymentTx.userId}: ${(err as Error).message}`,
      );
    });
  }

  private async reconcileDailyTopups(userId: string): Promise<void> {
    const todayStartWib = startOfDayWIB();

    const wallet = await this.prisma.wallet.findUnique({
      where: { userId },
      select: { todayTopupAmount: true },
    });
    if (!wallet) return;

    const successfulTopups = await this.prisma.walletTransaction.aggregate({
      where: {
        wallet: { userId },
        type: WalletTransactionType.TOP_UP,
        status: { in: [WalletTransactionStatus.SUCCESS, WalletTransactionStatus.PENDING] },
        createdAt: { gte: todayStartWib },
      },
      _sum: { amount: true },
    });

    const actualTotal = successfulTopups._sum.amount ?? BigInt(0);
    const counterTotal = wallet.todayTopupAmount;

    if (actualTotal !== counterTotal) {
      const delta = counterTotal - actualTotal;
      const msg = `RECONCILIATION MISMATCH for user ${userId}: daily counter=${counterTotal}n, actual successful topups=${actualTotal}n. Delta=${delta}n sen.`;
      this.logger.error(msg);
      this.redis
        .set(
          `alert:reconciliation_mismatch:${userId}:${formatWIBDate()}`,
          JSON.stringify({
            userId,
            counterTotal: counterTotal.toString(),
            actualTotal: actualTotal.toString(),
            delta: delta.toString(),
            detectedAt: new Date().toISOString(),
          }),
          86400,
        )
        .catch((e: unknown) =>
          this.logger.warn(
            `Failed to store reconciliation mismatch alert: ${(e as Error).message}`,
          ),
        );
    }
  }

  private parseProviderAmountToSen(value: string, field: string): bigint {
    if (!/^\d+(?:\.\d{1,2})?$/.test(value)) {
      throw new BadRequestException({
        code: 'INVALID_PROVIDER_AMOUNT',
        message: `${field} is not a valid IDR amount`,
      });
    }
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * BigInt(100) + BigInt((fraction + '00').slice(0, 2));
  }

  async handleTopupFailure(
    midtransOrderId: string,
    _reason: string = 'PAYMENT_FAILED',
    reversal?: { refundAmount?: string; refundReference?: string },
  ): Promise<void> {
    const paymentTx = await this.prisma.paymentTransaction.findUnique({
      where: { midtransOrderId },
    });
    if (!paymentTx) return;

    const reasonCode = _reason.toUpperCase();
    const isPostSettlementReversal = [
      'REFUND',
      'PARTIAL_REFUND',
      'CHARGEBACK',
      'PARTIAL_CHARGEBACK',
    ].includes(reasonCode);
    if (paymentTx.status === PaymentStatus.SUCCESS && !isPostSettlementReversal) {
      this.logger.warn(
        `Ignoring stale non-reversal top-up event for settled order ${midtransOrderId} (reason: ${_reason})`,
      );
      return;
    }
    const terminalPaymentStatus = isPostSettlementReversal
      ? PaymentStatus.REFUNDED
      : PaymentStatus.FAILED;
    const reversalSerial =
      paymentTx.status === PaymentStatus.SUCCESS && paymentTx.amount > BigInt(0)
        ? await this.walletTxSerialService.getNext()
        : null;

    if (paymentTx.status === PaymentStatus.PENDING) {
      // Normal failure path: payment never settled — mark failed, cancel the wallet tx.
      const topupFailureClaimed = await this.withWalletSerializableRetry(
        () =>
          this.prisma.$transaction(
            async (tx: Prisma.TransactionClient) => {
              const claimed = await tx.paymentTransaction.updateMany({
                where: { midtransOrderId, status: PaymentStatus.PENDING },
                data: { status: terminalPaymentStatus, failedAt: new Date() },
              });
              if (claimed.count === 0) return false;

              await tx.walletTransaction.updateMany({
                where: {
                  paymentTxId: paymentTx.id,
                  type: WalletTransactionType.TOP_UP,
                  status: WalletTransactionStatus.PENDING,
                },
                data: { status: WalletTransactionStatus.FAILED },
              });

              const wallet = await tx.wallet.findUnique({ where: { userId: paymentTx.userId } });
              if (wallet && paymentTx.createdAt >= startOfDayWIB()) {
                const clampedDecrement =
                  wallet.todayTopupAmount >= paymentTx.amount
                    ? paymentTx.amount
                    : wallet.todayTopupAmount;
                const counterUpdated = await tx.wallet.updateMany({
                  where: { id: wallet.id, version: wallet.version },
                  data: {
                    todayTopupAmount: { decrement: clampedDecrement },
                    version: { increment: 1 },
                  },
                });
                if (counterUpdated.count === 0) {
                  throw new ConflictException({
                    code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                    message: 'Concurrent top-up counter update detected; retry webhook',
                  });
                }
              }

              return true;
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          ),
        'TOPUP_FAILURE',
      );

      if (!topupFailureClaimed) return;

      this.prisma.notification
        .create({
          data: {
            notifId: generateNotifId(),
            userId: paymentTx.userId,
            type: NotificationType.WALLET_TOPUP_FAILED,
            category: getCategoryForType(NotificationType.WALLET_TOPUP_FAILED),
            title: 'Top-up Failed',
            body: `Top-up of Rp ${toIdr(paymentTx.amount).toLocaleString('id-ID')} failed to process. Please try again.`,
            isRead: false,
          },
        })
        .catch((notificationError: unknown) =>
          this.logger.warn(
            `silent-catch: top-up failure notification failed: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}`,
          ),
        );

      this.prisma.emitNotificationCreated({
        userId: paymentTx.userId,
        title: 'Top-up Failed',
        body: 'Top-up payment failed to process',
        data: { type: 'WALLET_TOPUP_FAILED' },
      });
    } else if (paymentTx.status === PaymentStatus.SUCCESS) {
      this.logger.warn(
        `Post-settlement reversal for order ${midtransOrderId} (reason: ${_reason})`,
      );
      await this.withWalletSerializableRetry(
        () =>
          this.prisma.$transaction(
            async (tx: Prisma.TransactionClient) => {
              await tx.$queryRaw`SELECT "id" FROM "payment_transactions" WHERE "id" = ${paymentTx.id} FOR UPDATE`;
              const currentPaymentTx = await tx.paymentTransaction.findUnique({
                where: { id: paymentTx.id },
              });
              if (!currentPaymentTx || currentPaymentTx.status !== PaymentStatus.SUCCESS) return;

              const isPartialRefund =
                reasonCode === 'PARTIAL_REFUND' || reasonCode === 'PARTIAL_CHARGEBACK';
              const isFullProviderReversal = reasonCode === 'REFUND' || reasonCode === 'CHARGEBACK';
              if (isPartialRefund && !reversal?.refundAmount) {
                throw new BadRequestException({
                  code: 'REFUND_AMOUNT_REQUIRED',
                  message: 'partial refund notification is missing refund_amount',
                });
              }

              const reportedRefundTotal = reversal?.refundAmount
                ? this.parseProviderAmountToSen(reversal.refundAmount, 'refund_amount')
                : currentPaymentTx.amount;
              if (
                reportedRefundTotal <= BigInt(0) ||
                reportedRefundTotal > currentPaymentTx.amount
              ) {
                throw new BadRequestException({
                  code: 'INVALID_REFUND_AMOUNT',
                  message: 'Provider refund amount is outside the original payment amount',
                });
              }
              if (isFullProviderReversal && reportedRefundTotal !== currentPaymentTx.amount) {
                throw new BadRequestException({
                  code: 'INVALID_REFUND_AMOUNT',
                  message: 'Full refund amount does not match the original payment amount',
                });
              }

              const alreadyRefunded = currentPaymentTx.refundedAmount ?? BigInt(0);
              const reversalAmount = reportedRefundTotal - alreadyRefunded;
              if (reversalAmount <= BigInt(0)) return;
              const fullyRefunded = reportedRefundTotal === currentPaymentTx.amount;

              const wallet = await tx.wallet.findUnique({ where: { userId: paymentTx.userId } });
              if (wallet && wallet.availableBalance >= reversalAmount) {
                const adjustCurrentDayCounter = paymentTx.createdAt >= startOfDayWIB();
                const clampedTopupDecrement =
                  wallet.todayTopupAmount >= reversalAmount
                    ? reversalAmount
                    : wallet.todayTopupAmount;
                const updated = await tx.wallet.updateMany({
                  where: { id: wallet.id, version: wallet.version },
                  data: {
                    availableBalance: { decrement: reversalAmount },
                    totalBalance: { decrement: reversalAmount },
                    ...(adjustCurrentDayCounter
                      ? { todayTopupAmount: { decrement: clampedTopupDecrement } }
                      : {}),
                    version: { increment: 1 },
                  },
                });
                if (updated.count === 0) {
                  this.logger.error(
                    `Reversal for order ${midtransOrderId}: optimistic lock conflict on wallet ${wallet.id}; locking wallet`,
                  );
                  await tx.wallet.update({
                    where: { id: wallet.id },
                    data: {
                      isLocked: true,
                      lockReason: `Auto-locked: post-settlement reversal version conflict — could not debit ${reversalAmount} (order: ${midtransOrderId})`,
                      lockedAt: new Date(),
                      lockedBy: 'SYSTEM',
                    },
                  });

                  await tx.notification.create({
                    data: {
                      notifId: generateNotifId(),
                      userId: paymentTx.userId,
                      type: NotificationType.SECURITY_ACCOUNT_LOCKED,
                      category: getCategoryForType(NotificationType.SECURITY_ACCOUNT_LOCKED),
                      title: 'Wallet Locked',
                      body: 'Your wallet has been automatically locked due to a technical issue with your payment. Please contact customer support for assistance.',
                      isRead: false,
                    },
                  });
                } else if (reversalSerial !== null) {
                  const originalTopup = await tx.walletTransaction.findFirst({
                    where: {
                      paymentTxId: paymentTx.id,
                      type: WalletTransactionType.TOP_UP,
                      status: WalletTransactionStatus.SUCCESS,
                    },
                    orderBy: { createdAt: 'asc' },
                    select: { id: true },
                  });
                  const reversalTx = await tx.walletTransaction.create({
                    data: {
                      txId: generateWalletTxId(reversalSerial),
                      walletId: wallet.id,
                      type: WalletTransactionType.ADMIN_DEBIT,
                      status: WalletTransactionStatus.SUCCESS,
                      amount: reversalAmount,
                      balanceBefore: wallet.availableBalance,
                      balanceAfter: wallet.availableBalance - reversalAmount,
                      paymentTxId: paymentTx.id,
                      description: `Top-up reversal (${reasonCode}) for ${midtransOrderId}`,
                      metadata: reversal?.refundReference
                        ? {
                            refundReference: reversal.refundReference,
                            refundAmount: reportedRefundTotal.toString(),
                          }
                        : undefined,
                      completedAt: new Date(),
                    },
                  });
                  if (originalTopup && fullyRefunded) {
                    await tx.walletTransaction.update({
                      where: { id: originalTopup.id },
                      data: {
                        status: WalletTransactionStatus.REVERSED,
                        reversalTxId: reversalTx.id,
                      },
                    });
                  }
                  await tx.paymentTransaction.update({
                    where: { id: currentPaymentTx.id },
                    data: {
                      refundedAmount: { increment: reversalAmount },
                      ...(fullyRefunded
                        ? { status: terminalPaymentStatus, failedAt: new Date() }
                        : {}),
                    },
                  });
                }
              } else if (wallet) {
                this.logger.error(
                  `Reversal for order ${midtransOrderId}: availableBalance (${wallet.availableBalance}) < refund amount (${reversalAmount}); locking wallet for manual reconciliation`,
                );
                await tx.wallet.update({
                  where: { id: wallet.id },
                  data: {
                    isLocked: true,
                    lockReason: `Auto-locked: post-settlement reversal insufficient balance — could not debit ${reversalAmount} (order: ${midtransOrderId}). Manual reconciliation required.`,
                    lockedAt: new Date(),
                    lockedBy: 'SYSTEM',
                  },
                });

                await tx.walletTransaction.updateMany({
                  where: {
                    paymentTxId: paymentTx.id,
                    type: WalletTransactionType.TOP_UP,
                    status: WalletTransactionStatus.SUCCESS,
                  },
                  data: {
                    // Preserve the original successful top-up row for auditability. The payment
                    // is refunded but cannot be automatically debited; manual recovery owns the
                    // outstanding balance while the wallet is locked.
                    failureReason: `Post-settlement reversal requires manual recovery: insufficient balance for ${midtransOrderId}`,
                    description: `Post-settlement reversal pending manual recovery (order: ${midtransOrderId}). Wallet locked.`,
                  },
                });

                await tx.paymentTransaction.update({
                  where: { id: currentPaymentTx.id },
                  data: {
                    refundedAmount: { increment: reversalAmount },
                    ...(fullyRefunded
                      ? { status: terminalPaymentStatus, failedAt: new Date() }
                      : {}),
                  },
                });

                await tx.notification.create({
                  data: {
                    notifId: generateNotifId(),
                    userId: paymentTx.userId,
                    type: NotificationType.SECURITY_ACCOUNT_LOCKED,
                    category: getCategoryForType(NotificationType.SECURITY_ACCOUNT_LOCKED),
                    title: 'Wallet Locked',
                    body: 'Your wallet has been automatically locked due to a technical issue with your payment. Please contact customer support for assistance.',
                    isRead: false,
                  },
                });
              } else {
                await tx.walletTransaction.updateMany({
                  where: {
                    paymentTxId: paymentTx.id,
                    type: WalletTransactionType.TOP_UP,
                    status: WalletTransactionStatus.SUCCESS,
                  },
                  data: { status: WalletTransactionStatus.FAILED },
                });
                await tx.paymentTransaction.update({
                  where: { id: currentPaymentTx.id },
                  data: {
                    refundedAmount: { increment: reversalAmount },
                    ...(fullyRefunded
                      ? { status: terminalPaymentStatus, failedAt: new Date() }
                      : {}),
                  },
                });
              }
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          ),
        'TOPUP_REVERSAL',
      );

      this.runRealtimeBestEffort(
        () =>
          this.realtime.emitToUser(paymentTx.userId, 'wallet.balance_updated', {
            userId: paymentTx.userId,
          }),
        'TOPUP_REVERSAL_BALANCE',
      );
    }
  }

  async confirmWithdrawOtp(
    userId: string,
    txId: string,
    otpCode: string,
  ): Promise<Record<string, unknown>> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user)
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'User not found' });
    if (!user.email) {
      throw new BadRequestException({
        code: 'EMAIL_NOT_CONFIGURED',
        message: 'Add an email address before confirming a withdrawal.',
      });
    }

    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet)
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Wallet not found' });

    // F-07: Early exit check — the authoritative lock check happens inside the transaction below (with FOR UPDATE).
    // This outer check is an optimization to avoid unnecessary DB work when the wallet is already known to be locked.
    if (wallet.isLocked) {
      throw new ForbiddenException({
        code: ErrorCodes.WALLET_LOCKED,
        message: 'Wallet is locked. Withdrawal cannot be confirmed.',
      });
    }

    const lifecycleLockKey = WALLET_LOCK(userId);
    const lifecycleLockToken = `confirm-withdraw:${Date.now()}:${randomBytes(16).toString('hex')}`;
    const lifecycleLockAcquired = await this.redis.setNx(
      lifecycleLockKey,
      lifecycleLockToken,
      WITHDRAW_LIFECYCLE_LOCK_TTL_SECONDS,
    );
    if (!lifecycleLockAcquired) {
      throw new ConflictException({
        code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
        message: 'Another withdrawal operation is in progress. Please try again.',
      });
    }

    try {
      const walletTx = await this.prisma.walletTransaction.findFirst({
        where: {
          txId,
          walletId: wallet.id,
          type: WalletTransactionType.WITHDRAW,
          status: WalletTransactionStatus.PENDING,
          withdrawStatus: WithdrawStatus.PENDING_OTP,
        },
        include: { bankAccount: true },
      });

      if (!walletTx) {
        // A network retry after the first successful claim should be safe and informative,
        // rather than returning a misleading 404 that encourages a second withdrawal.
        const alreadyClaimed = await this.prisma.walletTransaction.findFirst({
          where: { txId, walletId: wallet.id },
          select: { txId: true, amount: true, withdrawStatus: true },
        });
        if (alreadyClaimed?.withdrawStatus === WithdrawStatus.PENDING_PROCESS) {
          return {
            txId,
            status: WithdrawStatus.PENDING_PROCESS,
            message: 'Withdrawal is already awaiting admin approval',
          };
        }
        throw new NotFoundException({
          code: ErrorCodes.NOT_FOUND,
          message: 'Withdrawal transaction not found or already processed',
        });
      }

      const otpResult = await this.otpService.verifyOtpWithMetadata(
        user.email ?? '',
        OtpType.WITHDRAW_CONFIRMATION,
        otpCode,
        { consume: false },
      );
      if (!otpResult.valid) {
        throw new UnauthorizedException({
          code: ErrorCodes.OTP_INVALID,
          message: 'Invalid or expired OTP',
        });
      }
      if (!otpResult.metadata?.walletTxId || otpResult.metadata.walletTxId !== txId) {
        throw new BadRequestException({
          code: ErrorCodes.OTP_TX_MISMATCH,
          message: 'This OTP was issued for a different withdrawal',
        });
      }
      if (
        !otpResult.metadata.bankAccountId ||
        otpResult.metadata.bankAccountId !== walletTx.bankAccountId
      ) {
        throw new BadRequestException({
          code: ErrorCodes.OTP_TX_MISMATCH,
          message: 'This OTP was issued for a different bank account',
        });
      }
      if (
        otpResult.metadata.amountSen == null ||
        BigInt(otpResult.metadata.amountSen as string) !== walletTx.amount
      ) {
        throw new BadRequestException({
          code: ErrorCodes.OTP_TX_MISMATCH,
          message: 'This OTP was issued for a different withdrawal amount',
        });
      }
      const OTP_MAX_AGE_MS =
        (this.configService.get<number>('app.otpExpiresMinutes') ?? OTP_EXPIRES_MINUTES) *
        60 *
        1000;
      if (otpResult.metadata.timestamp == null) {
        throw new BadRequestException({
          code: ErrorCodes.OTP_INVALID,
          message: 'OTP is missing its expiry metadata. Please request a new one.',
        });
      }
      const otpAge = Date.now() - (otpResult.metadata.timestamp as number);
      if (otpAge > OTP_MAX_AGE_MS || otpAge < 0) {
        throw new BadRequestException({
          code: ErrorCodes.OTP_INVALID,
          message: 'OTP has expired. Please request a new one.',
        });
      }

      let result!: { txId: string; amount: bigint };
      let confirmLastError: unknown;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          result = await this.prisma.$transaction(
            async (tx: Prisma.TransactionClient) => {
              await tx.$queryRaw`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
              const lockedWallet = await tx.wallet.findUnique({ where: { id: wallet.id } });
              if (!lockedWallet)
                throw new NotFoundException({
                  code: ErrorCodes.NOT_FOUND,
                  message: 'Wallet not found',
                });

              if (lockedWallet.isLocked) {
                throw new ForbiddenException({
                  code: ErrorCodes.WALLET_LOCKED,
                  message: 'Wallet is locked. Withdrawal cannot be confirmed.',
                });
              }

              const claimed = await tx.walletTransaction.updateMany({
                where: {
                  id: walletTx.id,
                  type: WalletTransactionType.WITHDRAW,
                  status: WalletTransactionStatus.PENDING,
                  withdrawStatus: WithdrawStatus.PENDING_OTP,
                },
                data: {
                  withdrawStatus: WithdrawStatus.PENDING_PROCESS,
                  status: WalletTransactionStatus.PENDING,
                },
              });

              if (claimed.count === 0) {
                throw new ConflictException({
                  code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                  message: 'Withdrawal already being processed',
                });
              }

              return { txId, amount: walletTx.amount };
            },
            {
              isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
              maxWait: 10000,
              timeout: 15000,
            },
          );
          confirmLastError = null;
          break;
        } catch (err: unknown) {
          confirmLastError = err;
          if (!this.isRetryableDbError(err) || attempt === 3) {
            this.logger.error(
              `CONFIRM_WITHDRAW_TX_FAILED wallet=${wallet.id} txId=${txId} attempt=${attempt}/3`,
              err instanceof Error ? err.stack : String(err),
            );
            break;
          }
          this.logger.warn(
            `CONFIRM_WITHDRAW_TX_RETRY wallet=${wallet.id} txId=${txId} attempt=${attempt}/3`,
          );
          await new Promise(resolve => setTimeout(resolve, 100 * attempt));
        }
      }
      if (confirmLastError) throw confirmLastError;
      if (otpResult.otpId) {
        const consumed = await this.otpService.consumeVerifiedOtp(otpResult.otpId);
        if (!consumed)
          this.logger.warn(
            `Withdrawal OTP could not be consumed after claim: txId=${txId} otpId=${otpResult.otpId}`,
          );
      }

      this.runRealtimeBestEffort(
        () => this.realtime.emitToUser(userId, 'wallet.balance_updated', { userId }),
        'CONFIRM_WITHDRAW_BALANCE',
      );
      this.logger.log(
        `Withdrawal queued for admin approval: txId=${txId} userId=${userId} amount=${result.amount}`,
      );
      return {
        txId,
        status: 'PENDING_PROCESS',
        message: 'Withdrawal request submitted and awaiting admin approval',
      };
    } finally {
      await this.redis
        .releaseLock(lifecycleLockKey, lifecycleLockToken)
        .catch(err =>
          this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`),
        );
    }
  }

  async resendWithdrawOtp(
    userId: string,
    txId: string,
    ipAddress?: string,
  ): Promise<Record<string, unknown>> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user)
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'User not found' });
    if (!user.email) {
      throw new BadRequestException({
        code: 'EMAIL_NOT_CONFIGURED',
        message: 'Add an email address before requesting a new withdrawal confirmation code.',
      });
    }

    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet)
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Wallet not found' });

    if (wallet.isLocked) {
      throw new ForbiddenException({
        code: ErrorCodes.WALLET_LOCKED,
        message: 'Wallet is locked. Withdrawal OTP cannot be resent.',
      });
    }

    const lifecycleLockKey = WALLET_LOCK(userId);
    const lifecycleLockToken = `resend-withdraw:${Date.now()}:${randomBytes(16).toString('hex')}`;
    const lifecycleLockAcquired = await this.redis.setNx(
      lifecycleLockKey,
      lifecycleLockToken,
      WITHDRAW_LIFECYCLE_LOCK_TTL_SECONDS,
    );
    if (!lifecycleLockAcquired) {
      throw new ConflictException({
        code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
        message: 'Another withdrawal operation is in progress. Please try again.',
      });
    }

    try {
      const walletTx = await this.prisma.walletTransaction.findFirst({
        where: {
          txId,
          walletId: wallet.id,
          type: WalletTransactionType.WITHDRAW,
          status: WalletTransactionStatus.PENDING,
          withdrawStatus: WithdrawStatus.PENDING_OTP,
        },
      });
      if (!walletTx) {
        throw new NotFoundException({
          code: ErrorCodes.NOT_FOUND,
          message: 'No pending withdrawal found with this ID',
        });
      }

      const cooldownKey = WITHDRAW_OTP_COOLDOWN(userId);
      const acquired = await this.redis.setNx(cooldownKey, '1', 60);
      if (!acquired) {
        const ttl = await this.redis.ttl(cooldownKey);
        throw new BadRequestException({
          code: 'OTP_COOLDOWN',
          message: `Please wait ${ttl > 0 ? ttl : 60} seconds before requesting a new OTP.`,
        });
      }

      try {
        await this.otpService.invalidateOtps(user.email ?? '', OtpType.WITHDRAW_CONFIRMATION);
        const otp = await this.otpService.generateOtp(
          user.email ?? '',
          OtpType.WITHDRAW_CONFIRMATION,
          userId,
          {
            walletTxId: txId,
            amountSen: walletTx.amount.toString(),
            bankAccountId: walletTx.bankAccountId,
            timestamp: Date.now(),
          },
          ipAddress,
        );

        await this.emailQueue.add(
          'send',
          {
            to: user.email ?? '',
            subject: 'Kahade - Withdrawal Confirmation Code',
            templateName: 'withdrawal-otp',
            templateContext: { otp },
          },
          {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: true,
            removeOnFail: 50,
          },
        );

        const refreshed = await this.prisma.walletTransaction.updateMany({
          where: {
            id: walletTx.id,
            type: WalletTransactionType.WITHDRAW,
            status: WalletTransactionStatus.PENDING,
            withdrawStatus: WithdrawStatus.PENDING_OTP,
          },
          data: { updatedAt: new Date() },
        });
        if (refreshed.count === 0) {
          throw new ConflictException({
            code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
            message: 'Withdrawal was already confirmed or cancelled. Please refresh.',
          });
        }

        return {
          message: 'OTP resent successfully',
          otpExpiredAt: new Date(
            Date.now() +
              (this.configService.get<number>('app.otpExpiresMinutes') ?? OTP_EXPIRES_MINUTES) *
                60 *
                1000,
          ),
        };
      } catch (err: unknown) {
        await this.redis
          .del(cooldownKey)
          .catch((cleanupError: unknown) =>
            this.logger.warn(
              `OTP cooldown rollback failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
            ),
          );
        throw err;
      }
    } finally {
      await this.redis
        .releaseLock(lifecycleLockKey, lifecycleLockToken)
        .catch(err =>
          this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`),
        );
    }
  }

  private validatePinPolicy(pin: string): void {
    if (pin.length !== 6 || !/^\d{6}$/.test(pin)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'PIN must be exactly 6 digits',
      });
    }
    if (/^(\d)\1{5}$/.test(pin)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'PIN must not be all repeated digits',
      });
    }
    const WEAK_SEQUENCES = [
      '012345',
      '123456',
      '234567',
      '345678',
      '456789',
      '567890',
      '098765',
      '987654',
      '876543',
      '765432',
      '654321',
      '543210',
    ];
    if (WEAK_SEQUENCES.includes(pin)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'PIN must not be a sequential number',
      });
    }
    // [B-H18] Reject visually-trivial alternating two-digit patterns
    // (121212, 232323, 010101 …) — these are the second-most-guessed
    // family after sequential digits per Datagenetics PIN-leak study.
    if (/^(\d)(\d)\1\2\1\2$/.test(pin)) {
      const [a, b] = pin;
      if (a !== b) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'PIN must not be a repeating two-digit pattern',
        });
      }
    }
    // [B-H18] Reject paired-digit patterns (112233, 445566 …) — also high in
    // common-PIN frequency tables and easy to shoulder-surf.
    if (/^(\d)\1(\d)\2(\d)\3$/.test(pin)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'PIN must not consist of paired digits',
      });
    }
  }

  async setPin(
    userId: string,
    pin: string,
    currentPin?: string,
    password?: string,
    ip?: string,
  ): Promise<{ message: string }> {
    this.validatePinPolicy(pin);
    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet)
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Wallet not found' });

    const hasExistingPin = wallet.walletPinHash !== null && wallet.walletPinHash !== '';
    if (!password) {
      throw new BadRequestException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Account password is required to set or change wallet PIN',
      });
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { password: true },
    });
    if (!user?.password) {
      throw new BadRequestException({
        code: ErrorCodes.NOT_FOUND,
        message: 'User account not found',
      });
    }
    const passwordValid = await bcryptCompare(password, user.password);
    if (!passwordValid) {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Account password is incorrect',
      });
    }
    if (hasExistingPin) {
      if (!currentPin) {
        throw new BadRequestException({
          code: ErrorCodes.FORBIDDEN,
          message: 'Current PIN is required to change an existing PIN',
        });
      }
      await this.verifyWalletPin(wallet, currentPin, userId, ip);
    }

    const pinDigest = hmacPinDigest(this.walletPinPepper, pin);
    const hashedPin = await bcryptHash(pinDigest, getBcryptRounds());
    await this.prisma.wallet.update({
      where: { userId },
      data: { walletPinHash: hashedPin },
    });
    return {
      message: hasExistingPin
        ? 'Wallet PIN has been changed successfully'
        : 'Wallet PIN has been set successfully',
    };
  }

  async verifyPin(userId: string, pin: string, ip?: string): Promise<{ valid: boolean }> {
    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet)
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Wallet not found' });

    await this.verifyWalletPin(wallet, pin, userId, ip);
    return { valid: true };
  }

  private paymentMethodsCache: { data: Record<string, unknown>; ts: number } | null = null;
  private readonly PAYMENT_METHODS_CACHE_TTL = 60_000;

  getPaymentMethods(): Record<string, unknown> {
    const now = Date.now();
    if (
      this.paymentMethodsCache &&
      now - this.paymentMethodsCache.ts < this.PAYMENT_METHODS_CACHE_TTL
    ) {
      return this.paymentMethodsCache.data;
    }

    const feeQris = this.configService.get<number>('app.paymentFeeQrisPercent') ?? 0.7;

    const result = {
      methods: [
        {
          id: 'QRIS',
          nameKey: 'payment.qris',
          name: 'QRIS',
          category: 'qris',
          enabled: true,
          minAmount: 10000,
          maxAmount: 10000000,
          feeType: 'percent',
          fee: feeQris,
        },
      ],
    };
    this.paymentMethodsCache = { data: result, ts: now };
    return result;
  }

  private async getHeldEscrowReleaseAmount(
    tx: Prisma.TransactionClient,
    walletId: string,
  ): Promise<bigint> {
    const holdCutoff = new Date(Date.now() - ESCROW_RELEASE_HOLD_HOURS * 60 * 60 * 1000);
    const wallet = await tx.wallet.findUnique({
      where: { id: walletId },
      select: { userId: true },
    });
    if (!wallet) return BigInt(0);
    const recentCompletedOrders = await tx.order.findMany({
      where: {
        sellerId: wallet.userId,
        // DISPUTED post-completion orders already have their seller funds moved back
        // into escrow by dispute submission; counting them again would double-hold money.
        status: 'COMPLETED',
        completedAt: { gt: holdCutoff },
      },
      select: { sellerReceiveAmount: true },
    });
    return recentCompletedOrders.reduce((sum, o) => sum + o.sellerReceiveAmount, BigInt(0));
  }

  private runRealtimeBestEffort(task: () => void, label: string): void {
    try {
      task();
    } catch (error: unknown) {
      this.logger.warn(
        `${label} realtime side effect failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async withWalletSerializableRetry<T>(
    operation: () => Promise<T>,
    label: string,
  ): Promise<T> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await operation();
      } catch (error: unknown) {
        if (!this.isRetryableDbError(error) || attempt === 3) throw error;
        this.logger.warn(`${label}_RETRY attempt=${attempt}/3`);
        await new Promise(resolve => setTimeout(resolve, 100 * attempt + randomInt(0, 50)));
      }
    }
    throw new Error(`${label} exhausted retry loop`);
  }

  private isRetryableDbError(err: unknown): boolean {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
      return true;
    }
    if (err instanceof Prisma.PrismaClientUnknownRequestError) {
      const msg = err.message.toLowerCase();
      if (
        msg.includes('40001') ||
        msg.includes('serialization') ||
        msg.includes('40p01') ||
        msg.includes('deadlock')
      ) {
        return true;
      }
    }
    return false;
  }

  private async getNextWalletTxSerial(): Promise<number> {
    return this.walletTxSerialService.getNext();
  }

  private async getNextPaymentSerial(): Promise<number> {
    return this.walletTxSerialService.getNextForPrefix('payment_serial');
  }
}
