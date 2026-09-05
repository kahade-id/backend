import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  KycStatus,
  WalletTransactionType,
  WalletTransactionStatus,
  WithdrawStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import * as ErrorCodes from '../../common/constants/error-codes';
import { toSen, toIdr } from '../../common/utils/currency.util';
import { startOfDayWIB } from '../../common/utils/date.util';
import { generateWalletTxId } from '../../common/utils/id-generator.util';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { decryptAES } from '../../common/utils/crypto.util';
import {
  WALLET_MIN_WITHDRAW,
  WALLET_MAX_WITHDRAW_PER_TX,
  WALLET_DAILY_WITHDRAW_LIMIT,
  WALLET_KYC_FREE_LIMIT,
  ESCROW_RELEASE_HOLD_HOURS,
} from '../../common/constants/app.constants';

// Thrown inside the tx to roll it back (including the lastExecutedAt claim) while
// carrying the reason out to the caller as a normal skip rather than an error.
const SKIP_PREFIX = 'SKIP_ROLLBACK:';
const MAX_SCHEDULE_MIN_AMOUNT = 100_000_000;

@Injectable()
export class ScheduledWithdrawalService {
  private readonly logger = new Logger(ScheduledWithdrawalService.name);
  private readonly minWithdraw: number;
  private readonly maxWithdrawPerTx: number;
  private readonly dailyWithdrawLimit: number;

  constructor(
    private prisma: PrismaService,
    private walletTxSerialService: WalletTxSerialService,
    private configService: ConfigService,
  ) {
    // Same config keys and fallbacks as WalletService, so the manual and automated
    // withdrawal paths cannot drift apart when an operator overrides a limit.
    this.minWithdraw =
      this.configService.get<number>('app.walletMinWithdraw') ?? WALLET_MIN_WITHDRAW;
    this.maxWithdrawPerTx =
      this.configService.get<number>('app.walletMaxWithdrawPerTx') ?? WALLET_MAX_WITHDRAW_PER_TX;
    this.dailyWithdrawLimit =
      this.configService.get<number>('app.walletDailyWithdrawLimit') ?? WALLET_DAILY_WITHDRAW_LIMIT;
  }

  /*
   * Mirrors WalletService.getHeldEscrowReleaseAmount. Funds a seller received from
   * a recently completed order stay non-withdrawable until the post-completion
   * dispute window closes, so a refund is still collectable. Duplicated rather
   * than imported because WalletModule and WithdrawalsModule would otherwise form
   * a cycle; keep the two in sync.
   */
  private async getHeldEscrowReleaseAmount(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<bigint> {
    const holdCutoff = new Date(Date.now() - ESCROW_RELEASE_HOLD_HOURS * 60 * 60 * 1000);
    const recentCompletedOrders = await tx.order.findMany({
      where: {
        sellerId: userId,
        // A post-completion dispute moves seller funds back to escrow; only
        // still-completed orders remain in the withdrawal hold window.
        status: 'COMPLETED',
        completedAt: { gt: holdCutoff },
      },
      select: { sellerReceiveAmount: true },
    });
    return recentCompletedOrders.reduce((sum, o) => sum + o.sellerReceiveAmount, BigInt(0));
  }

  async processScheduledWithdrawal(
    scheduleId: string,
  ): Promise<{ skipped: boolean; reason?: string }> {
    const schedule = await this.prisma.scheduledWithdrawal.findUnique({
      where: { id: scheduleId },
      include: {
        bankAccount: true,
        user: {
          select: { id: true, isActive: true, isBanned: true, deletedAt: true, kycStatus: true },
        },
      },
    });
    if (!schedule) return { skipped: true, reason: 'Schedule not found' };
    if (!schedule.isActive) return { skipped: true, reason: 'Schedule is inactive' };
    if (!schedule.user.isActive || schedule.user.isBanned || schedule.user.deletedAt != null)
      return { skipped: true, reason: 'User account is not active' };
    if (!schedule.bankAccount.isVerified)
      return { skipped: true, reason: 'Bank account is not verified' };

    const now = new Date();
    const todayStart = startOfDayWIB();

    if (schedule.lastExecutedAt && schedule.lastExecutedAt >= todayStart) {
      return { skipped: true, reason: 'Already processed for the current period' };
    }

    const wallet = await this.prisma.wallet.findUnique({ where: { userId: schedule.userId } });
    if (!wallet) {
      this.logger.warn(
        `No wallet found for scheduled withdrawal ${scheduleId}, user ${schedule.userId}`,
      );
      return { skipped: true, reason: 'Wallet not found' };
    }

    if (wallet.isLocked) return { skipped: true, reason: 'Wallet is locked' };

    if (schedule.minAmount > 0n && wallet.availableBalance < schedule.minAmount) {
      return { skipped: true, reason: 'Balance below minimum amount' };
    }

    if (wallet.availableBalance <= 0n) return { skipped: true, reason: 'No balance to withdraw' };

    let walletTxId!: string;

    let accountLastFour = '****';
    try {
      const plain = await decryptAES(schedule.bankAccount.accountNumber);
      accountLastFour = plain.slice(-4);
    } catch (err) {
      this.logger.warn(
        `Failed to decrypt bank account for schedule ${scheduleId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const sanitizedBankName = (schedule.bankAccount.bankName ?? '')
      .replace(/[^\w\s\-&.]/g, '')
      .slice(0, 50);

    const created = await this.prisma
      .$transaction(
        async (tx: Prisma.TransactionClient) => {
          const lockResult = await tx.$executeRaw`
        UPDATE scheduled_withdrawals
        SET "lastExecutedAt" = ${now}
        WHERE id = ${scheduleId}
          AND "isActive" = true
          AND ("lastExecutedAt" IS NULL OR "lastExecutedAt" < ${todayStart})
      `;
          if (lockResult === 0) return false;

          await tx.$queryRaw`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
          const lockedWallet = await tx.wallet.findUnique({ where: { id: wallet.id } });
          if (!lockedWallet || lockedWallet.isLocked || lockedWallet.availableBalance <= 0n) {
            throw new Error(`${SKIP_PREFIX}Wallet unavailable or empty`);
          }

          // Re-read the bank account inside the tx — it may have been deleted between
          // the schedule being created and this run.
          const verifiedBankAccount = await tx.bankAccount.findFirst({
            where: {
              id: schedule.bankAccountId,
              userId: schedule.userId,
              deletedAt: null,
              isVerified: true,
            },
          });
          if (!verifiedBankAccount) {
            throw new Error(
              `${SKIP_PREFIX}Bank account no longer exists or does not belong to the user`,
            );
          }

          // Funds still inside the post-completion dispute window are not withdrawable.
          const heldAmount = await this.getHeldEscrowReleaseAmount(tx, schedule.userId);
          const withdrawableBalance = lockedWallet.availableBalance - heldAmount;
          if (withdrawableBalance <= 0n) {
            throw new Error(`${SKIP_PREFIX}All funds are within the escrow holding period`);
          }

          // Daily limit is shared with manual withdrawals, with the same lazy WIB reset.
          const needsLazyReset = Boolean(
            lockedWallet.lastLimitResetAt && lockedWallet.lastLimitResetAt < todayStart,
          );
          const effectiveWithdraw = needsLazyReset ? 0n : lockedWallet.todayWithdrawAmount;
          const dailyRemaining = toSen(this.dailyWithdrawLimit) - effectiveWithdraw;
          if (dailyRemaining <= 0n) {
            throw new Error(`${SKIP_PREFIX}Daily withdrawal limit already reached`);
          }

          // KYC gate: an unverified user may not withdraw above the KYC-free threshold,
          // so cap rather than reject — the remainder rolls into the next run.
          const kycCeiling =
            schedule.user.kycStatus === KycStatus.APPROVED ? null : toSen(WALLET_KYC_FREE_LIMIT);

          /*
           * The schedule is "withdraw everything available", so every ceiling is applied
           * as a clamp rather than a rejection: a user whose balance exceeds a limit still
           * gets the maximum permitted amount, and the rest carries to the next run. Only
           * the per-transaction minimum can block the run outright, since a below-minimum
           * withdrawal is not a valid transaction at all.
           */
          const ceilings = [
            withdrawableBalance,
            dailyRemaining,
            toSen(this.maxWithdrawPerTx),
            ...(kycCeiling === null ? [] : [kycCeiling]),
          ];
          const amount = ceilings.reduce((min, c) => (c < min ? c : min));

          // minAmount is the user's own "don't bother unless I've accumulated this much" floor.
          if (schedule.minAmount > 0n && withdrawableBalance < schedule.minAmount) {
            throw new Error(`${SKIP_PREFIX}Balance below the schedule minimum`);
          }

          if (amount < toSen(this.minWithdraw)) {
            throw new Error(`${SKIP_PREFIX}Withdrawable amount is below the minimum withdrawal`);
          }

          if (amount <= 0n) throw new Error(`${SKIP_PREFIX}Nothing withdrawable`);

          // Allocate the audit serial only after the one-per-period claim and every
          // in-transaction guard has passed. A serial is a durable ledger identifier,
          // not a reservation: skipped runs must not create unexplained gaps.
          walletTxId = generateWalletTxId(await this.walletTxSerialService.getNext());

          const updateResult = await tx.wallet.updateMany({
            where: {
              id: wallet.id,
              version: lockedWallet.version,
              availableBalance: { gte: amount },
            },
            data: needsLazyReset
              ? {
                  availableBalance: { decrement: amount },
                  totalBalance: { decrement: amount },
                  todayTopupAmount: 0n,
                  todayWithdrawAmount: amount,
                  lastLimitResetAt: new Date(),
                  version: { increment: 1 },
                }
              : {
                  availableBalance: { decrement: amount },
                  totalBalance: { decrement: amount },
                  todayWithdrawAmount: { increment: amount },
                  version: { increment: 1 },
                },
          });

          if (updateResult.count === 0) throw new Error(`${SKIP_PREFIX}Concurrent wallet update`);

          await tx.walletTransaction.create({
            data: {
              txId: walletTxId,
              walletId: wallet.id,
              type: WalletTransactionType.WITHDRAW,
              status: WalletTransactionStatus.PENDING,
              amount,
              balanceBefore: lockedWallet.totalBalance,
              balanceAfter: lockedWallet.totalBalance - amount,
              bankAccountId: schedule.bankAccountId,
              withdrawStatus: WithdrawStatus.PENDING_PROCESS,
              description: `Scheduled withdrawal to ${sanitizedBankName} ****${accountLastFour}`,
              metadata: { scheduledWithdrawalId: scheduleId, automated: true },
            },
          });

          return { ok: true as const, amount };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      )
      .catch((err: unknown) => {
        if (err instanceof Error && err.message.startsWith(SKIP_PREFIX)) {
          return { ok: false as const, reason: err.message.slice(SKIP_PREFIX.length) };
        }
        throw err;
      });

    if (created === false) {
      return { skipped: true, reason: 'Already processed for the current period' };
    }

    if (!created.ok) {
      return { skipped: true, reason: created.reason };
    }

    this.logger.log(
      `SCHEDULED_WITHDRAW_CREATED schedule=${scheduleId} user=${schedule.userId} txId=${walletTxId} amountSen=${created.amount}`,
    );

    return { skipped: false };
  }

  async createSchedule(
    userId: string,
    dto: {
      bankAccountId: string;
      dayOfWeek: number;
      minAmount?: number;
    },
  ): Promise<object> {
    if (!Number.isInteger(dto.dayOfWeek) || dto.dayOfWeek < 0 || dto.dayOfWeek > 6) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_SCHEDULE,
        message: 'dayOfWeek must be 0 (Sunday) to 6 (Saturday)',
      });
    }
    this.validateScheduleMinimum(dto.minAmount);

    const bankAccount = await this.prisma.bankAccount.findFirst({
      where: { id: dto.bankAccountId, userId, deletedAt: null },
    });
    if (!bankAccount) {
      throw new NotFoundException({
        code: ErrorCodes.SCHEDULE_NOT_FOUND,
        message: 'Bank account not found or not active',
      });
    }
    if (!bankAccount.isVerified) {
      throw new BadRequestException({
        code: ErrorCodes.BANK_ACCOUNT_NOT_VERIFIED,
        message: 'Bank account must be verified before scheduling withdrawals',
      });
    }

    const existing = await this.prisma.scheduledWithdrawal.findUnique({
      where: { userId_dayOfWeek: { userId, dayOfWeek: dto.dayOfWeek } },
    });
    if (existing) {
      throw new BadRequestException({
        code: ErrorCodes.SCHEDULE_ALREADY_EXISTS,
        message: 'Schedule already exists for this day',
      });
    }

    const schedule = await this.prisma.scheduledWithdrawal.create({
      data: {
        userId,
        bankAccountId: dto.bankAccountId,
        dayOfWeek: dto.dayOfWeek,
        minAmount: dto.minAmount === undefined ? 0n : toSen(dto.minAmount),
      },
    });

    return this.formatSchedule(schedule);
  }

  async getSchedules(userId: string): Promise<object[]> {
    const schedules = await this.prisma.scheduledWithdrawal.findMany({
      where: { userId, isActive: true },
      orderBy: { dayOfWeek: 'asc' },
    });

    return schedules.map(s => this.formatSchedule(s));
  }

  async updateSchedule(
    userId: string,
    scheduleId: string,
    dto: {
      dayOfWeek?: number;
      minAmount?: number;
      isActive?: boolean;
      bankAccountId?: string;
    },
  ): Promise<object> {
    const schedule = await this.prisma.scheduledWithdrawal.findUnique({
      where: { id: scheduleId },
    });
    if (!schedule)
      throw new NotFoundException({
        code: ErrorCodes.SCHEDULE_NOT_FOUND,
        message: 'Schedule not found',
      });
    if (schedule.userId !== userId)
      throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Not your schedule' });

    const data: {
      dayOfWeek?: number;
      minAmount?: bigint;
      isActive?: boolean;
      bankAccountId?: string;
    } = {};
    if (dto.dayOfWeek !== undefined) {
      if (!Number.isInteger(dto.dayOfWeek) || dto.dayOfWeek < 0 || dto.dayOfWeek > 6) {
        throw new BadRequestException({
          code: ErrorCodes.INVALID_SCHEDULE,
          message: 'dayOfWeek must be 0 (Sunday) to 6 (Saturday)',
        });
      }
      if (dto.dayOfWeek !== schedule.dayOfWeek) {
        const existing = await this.prisma.scheduledWithdrawal.findUnique({
          where: { userId_dayOfWeek: { userId, dayOfWeek: dto.dayOfWeek } },
          select: { id: true },
        });
        if (existing && existing.id !== schedule.id) {
          throw new BadRequestException({
            code: ErrorCodes.SCHEDULE_ALREADY_EXISTS,
            message: 'Schedule already exists for this day',
          });
        }
      }
      data.dayOfWeek = dto.dayOfWeek;
    }
    if (dto.minAmount !== undefined) {
      this.validateScheduleMinimum(dto.minAmount);
      data.minAmount = toSen(dto.minAmount);
    }
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.bankAccountId !== undefined) {
      const bankAccount = await this.prisma.bankAccount.findFirst({
        where: { id: dto.bankAccountId, userId, deletedAt: null },
      });
      if (!bankAccount) {
        throw new NotFoundException({
          code: ErrorCodes.SCHEDULE_NOT_FOUND,
          message: 'Bank account not found or not active',
        });
      }
      if (!bankAccount.isVerified) {
        throw new BadRequestException({
          code: ErrorCodes.BANK_ACCOUNT_NOT_VERIFIED,
          message: 'Bank account must be verified before scheduling withdrawals',
        });
      }
      data.bankAccountId = dto.bankAccountId;
    }

    const updated = await this.prisma.scheduledWithdrawal.update({
      where: { id: scheduleId },
      data,
    });
    return this.formatSchedule(updated);
  }

  async deleteSchedule(userId: string, scheduleId: string): Promise<{ message: string }> {
    const schedule = await this.prisma.scheduledWithdrawal.findUnique({
      where: { id: scheduleId },
    });
    if (!schedule)
      throw new NotFoundException({
        code: ErrorCodes.SCHEDULE_NOT_FOUND,
        message: 'Schedule not found',
      });
    if (schedule.userId !== userId)
      throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Not your schedule' });

    await this.prisma.scheduledWithdrawal.update({
      where: { id: scheduleId },
      data: { isActive: false },
    });
    return { message: 'Schedule deactivated' };
  }

  private formatSchedule(s: {
    id: string;
    dayOfWeek: number;
    minAmount: bigint;
    isActive: boolean;
    bankAccountId: string;
    lastExecutedAt: Date | null;
    createdAt: Date;
  }): object {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return {
      id: s.id,
      dayOfWeek: s.dayOfWeek,
      dayName: dayNames[s.dayOfWeek],
      minAmount: toIdr(s.minAmount),
      isActive: s.isActive,
      bankAccountId: s.bankAccountId,
      lastExecutedAt: s.lastExecutedAt,
      createdAt: s.createdAt,
    };
  }

  private validateScheduleMinimum(minAmount: number | undefined): void {
    if (minAmount === undefined) return;
    if (!Number.isInteger(minAmount) || minAmount < 1 || minAmount > MAX_SCHEDULE_MIN_AMOUNT) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_SCHEDULE,
        message: `minAmount must be an integer from 1 to ${MAX_SCHEDULE_MIN_AMOUNT.toLocaleString('id-ID')}`,
      });
    }
  }
}
