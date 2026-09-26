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
import { WalletService } from '../wallet/wallet.service';
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

// DRIFT-01 (fix 2026-09-26): field rekening yang aman dibawa ke response jadwal.
// accountNumber/accountName terenkripsi — didekripsi + di-mask di formatBankAccount;
// nomor mentah TIDAK PERNAH dikirim ke klien.
const BANK_ACCOUNT_SELECT = {
  id: true,
  bankCode: true,
  bankName: true,
  accountName: true,
  accountNumber: true,
} as const;

/** Schedule + relasi bankAccount untuk formatSchedule (DRIFT-01). */
type ScheduleWithBankAccount = Prisma.ScheduledWithdrawalGetPayload<{
  include: { bankAccount: { select: typeof BANK_ACCOUNT_SELECT } };
}>;

/**
 * DRIFT-02 (fix 2026-09-26): hitung penarikan berikutnya dari dayOfWeek.
 * Eksekusi cron berjalan tiap 06:00 WIB (`process-scheduled-withdrawals`), jadi
 * next run = 06:00 WIB berikutnya pada weekday yang cocok. Kalau hari ini cocok
 * dan sekarang belum lewat 06:00 WIB → hari ini 06:00; kalau sudah lewat →
 * minggu depan. Return ISO string (UTC).
 */
function computeNextRunAt(dayOfWeek: number): string {
  const WIB_OFFSET_MS = 7 * 3600_000;
  const shiftedNow = new Date(Date.now() + WIB_OFFSET_MS); // jam "UTC" yang menunjukkan WIB
  const todayDow = shiftedNow.getUTCDay();
  const addDays = (dayOfWeek - todayDow + 7) % 7;
  const shiftedToday6am = Date.UTC(
    shiftedNow.getUTCFullYear(),
    shiftedNow.getUTCMonth(),
    shiftedNow.getUTCDate(),
    6, 0, 0,
  );
  let targetShifted = shiftedToday6am + addDays * 86400_000;
  if (targetShifted <= shiftedNow.getTime()) {
    targetShifted += 7 * 86400_000;
  }
  return new Date(targetShifted - WIB_OFFSET_MS).toISOString();
}

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
    private walletService: WalletService,
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
      pin: string;
    },
    ip?: string,
  ): Promise<object> {
    // WF-003: jadwal penarikan otomatis adalah otorisasi penarikan — wajib PIN,
    // sama seperti penarikan manual.
    await this.walletService.assertWalletPin(userId, dto.pin, ip);

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

    let schedule: ScheduleWithBankAccount;
    try {
      schedule = await this.prisma.scheduledWithdrawal.create({
        data: {
          userId,
          bankAccountId: dto.bankAccountId,
          dayOfWeek: dto.dayOfWeek,
          minAmount: dto.minAmount === undefined ? 0n : toSen(dto.minAmount),
        },
        // DRIFT-01 (fix 2026-09-26): formatSchedule butuh relasi bankAccount
        // untuk objek nested di response — tanpa include, kontrak frontend crash.
        include: { bankAccount: { select: BANK_ACCOUNT_SELECT } },
      });
    } catch (err) {
      // R2-G (audit): the "already exists" pre-check races with concurrent requests;
      // the userId+dayOfWeek unique constraint then surfaced as an unhandled P2002
      // (500). Map it back to the documented conflict response.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BadRequestException({
          code: ErrorCodes.SCHEDULE_ALREADY_EXISTS,
          message: 'Schedule already exists for this day',
        });
      }
      throw err;
    }

    return this.formatSchedule(schedule);
  }

  async getSchedules(userId: string): Promise<object[]> {
    const schedules = await this.prisma.scheduledWithdrawal.findMany({
      where: { userId, isActive: true },
      orderBy: { dayOfWeek: 'asc' },
      // DRIFT-01 (fix 2026-09-26): sertakan relasi bankAccount untuk objek nested.
      include: { bankAccount: { select: BANK_ACCOUNT_SELECT } },
    });

    return Promise.all(schedules.map(s => this.formatSchedule(s)));
  }

  async updateSchedule(
    userId: string,
    scheduleId: string,
    dto: {
      dayOfWeek?: number;
      minAmount?: number;
      isActive?: boolean;
      bankAccountId?: string;
      pin: string;
    },
    ip?: string,
  ): Promise<object> {
    // WF-003: perubahan jadwal (termasuk toggle aktif/nonaktif) wajib PIN.
    await this.walletService.assertWalletPin(userId, dto.pin, ip);

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

    let updated: ScheduleWithBankAccount;
    try {
      updated = await this.prisma.scheduledWithdrawal.update({
        where: { id: scheduleId },
        data,
        // DRIFT-01 (fix 2026-09-26): sertakan relasi bankAccount untuk objek nested.
        include: { bankAccount: { select: BANK_ACCOUNT_SELECT } },
      });
    } catch (err) {
      // R2-G (audit): day-of-week moves race against another create/update the same
      // way; the unique-violation must not surface as a 500.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BadRequestException({
          code: ErrorCodes.SCHEDULE_ALREADY_EXISTS,
          message: 'Schedule already exists for this day',
        });
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Schedule not found' });
      }
      throw err;
    }
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

  private formatSchedule(s: ScheduleWithBankAccount): Promise<object> {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return this.formatBankAccount(s.bankAccount).then(bankAccount => ({
      id: s.id,
      dayOfWeek: s.dayOfWeek,
      dayName: dayNames[s.dayOfWeek],
      minAmount: toIdr(s.minAmount),
      isActive: s.isActive,
      bankAccountId: s.bankAccountId,
      // DRIFT-01 (fix 2026-09-26): objek rekening terdenormalisasi — frontend
      // mengharapkan nested `bankAccount`, bukan cuma flat `bankAccountId`.
      bankAccount,
      // DRIFT-02 (fix 2026-09-26): kontrak frontend memakai `lastRunAt` /
      // `nextRunAt`, bukan `lastExecutedAt`. ISO string eksplisit (bukan Date
      // mentah) agar serialisasi deterministik.
      lastRunAt: s.lastExecutedAt ? s.lastExecutedAt.toISOString() : null,
      nextRunAt: computeNextRunAt(s.dayOfWeek),
      createdAt: s.createdAt,
    }));
  }

  /**
   * DRIFT-02 (fix 2026-09-26): rekening terdenormalisasi untuk response jadwal.
   * KEAMANAN: nomor rekening mentah TIDAK PERNAH dikirim — pola masking sama
   * dengan bank-accounts.service.ts (`****` + 4 digit terakhir).
   */
  private async formatBankAccount(acc: ScheduleWithBankAccount['bankAccount']): Promise<object> {
    let maskedAccountNumber = '****';
    let accountName = 'Bank account';
    try {
      const plain = await decryptAES(acc.accountNumber);
      maskedAccountNumber = `****${plain.slice(-4)}`;
    } catch {
      // biarkan mask default bila dekripsi gagal
    }
    try {
      accountName = await decryptAES(acc.accountName);
    } catch {
      // fallback: accountName mungkin belum terenkripsi (data pra-migrasi)
    }
    return {
      id: acc.id,
      bankName: acc.bankName,
      bankCode: acc.bankCode,
      maskedAccountNumber,
      accountName,
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
