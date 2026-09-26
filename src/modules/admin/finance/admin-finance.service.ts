import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { Prisma, AuditAction, WalletTransactionType, WalletTransactionStatus } from '@prisma/client';
import { createPaginatedResponse } from '../../../common/dto/pagination.dto';
import { FinanceTransactionQueryDto } from './dto/finance-query.dto';
import { WithdrawalApproveDto, WithdrawalRejectDto } from './dto/withdrawal-action.dto';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { MidtransService } from '../../../modules/payment/midtrans.service';
import { decryptAES } from '../../../common/utils/crypto.util';
import { toIdr } from '../../../common/utils/currency.util';
import { parseDateBoundaryWIB, startOfDayWIB, toWIB } from '../../../common/utils/date.util';
import { DashboardService } from '../dashboard/dashboard.service';

@Injectable()
export class AdminFinanceService {
  private readonly logger = new Logger(AdminFinanceService.name);

  private sanitizeAdminNote(note?: string): string {
    return (note ?? '')
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1000);
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly midtransService: MidtransService,
    // AW-018: invalidasi cache summary dashboard (via helper terpusat).
    private readonly dashboard: DashboardService,
  ) {}

  async listTransactions(query: FinanceTransactionQueryDto): Promise<object> {
    const { page = 1, limit = 20, type, status, startDate, endDate, q } = query;
    const safePage = Number.isInteger(page) && page > 0 ? page : 1;
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;

    if (!startDate || !endDate) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_DATE_RANGE,
        message: 'startDate and endDate are mandatory for transaction listing',
      });
    }

    const start = parseDateBoundaryWIB(startDate, 'start');
    const end = parseDateBoundaryWIB(endDate, 'end');
    if (!start || !end) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_DATE_RANGE,
        message: 'startDate and endDate must be valid ISO date strings',
      });
    }
    if (start.getTime() > end.getTime()) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_DATE_RANGE,
        message: 'startDate must be before or equal to endDate',
      });
    }
    const diffDays = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays > 90) {
      throw new BadRequestException({
        code: ErrorCodes.DATE_RANGE_TOO_LARGE,
        message: 'Date range cannot exceed 90 days',
      });
    }

    const where: Prisma.WalletTransactionWhereInput = {};

    if (type) {
      where.type = type;
    }
    if (status) {
      where.status = status;
    }
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = start;
      if (endDate) where.createdAt.lte = end;
    }

    // WF-013: pencarian server-side — digabung AND dengan filter lain.
    const search = (q ?? '').trim().slice(0, 100);
    if (search) {
      where.OR = [
        { txId: { contains: search } },
        { description: { contains: search, mode: 'insensitive' } },
        { order: { orderId: { contains: search } } },
      ];
    }

    const [transactions, total] = await Promise.all([
      this.prisma.walletTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
        include: {
          wallet: {
            select: {
              userId: true,
              user: { select: { userId: true, fullName: true, email: true } },
            },
          },
          order: { select: { id: true, orderId: true } },
          bankAccount: { select: { id: true, bankCode: true } },
        },
      }),
      this.prisma.walletTransaction.count({ where }),
    ]);

    const serialized = transactions.map(tx => ({
      ...tx,
      // Convert BigInt sen amounts to IDR numbers for frontend display.
      amount: toIdr(tx.amount),
      balanceBefore: toIdr(tx.balanceBefore),
      balanceAfter: toIdr(tx.balanceAfter),
    }));

    return createPaginatedResponse(serialized, total, safePage, safeLimit);
  }

  async getTransactionDetail(
    txId: string,
    adminId: string,
    ipAddress: string = 'unknown',
  ): Promise<object> {
    // B-22 (audit-fix): lookup by public txId only.
    const tx = await this.prisma.walletTransaction.findFirst({
      where: { txId },
      include: {
        wallet: {
          select: {
            userId: true,
            user: { select: { userId: true, fullName: true, email: true } },
          },
        },
        order: { select: { id: true, orderId: true, status: true } },
        bankAccount: {
          select: { id: true, bankCode: true, accountName: true, accountNumber: true },
        },
        paymentTx: { select: { id: true, midtransOrderId: true, method: true, status: true } },
      },
    });

    if (!tx) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Transaction not found',
      });
    }

    const result = {
      ...tx,
      // Convert BigInt sen amounts to IDR numbers for frontend display.
      amount: toIdr(tx.amount),
      balanceBefore: toIdr(tx.balanceBefore),
      balanceAfter: toIdr(tx.balanceAfter),
    };

    if (result.bankAccount) {
      let maskedNumber = '****';
      try {
        const plain = await decryptAES(result.bankAccount.accountNumber);
        maskedNumber = `****${plain.slice(-4)}`;
        this.auditLog.logAdminAction({
          adminId,
          action: AuditAction.ADMIN_ACTION,
          targetType: 'BankAccount',
          targetId: result.bankAccount.id ?? 'unknown',
          description: 'Bank account number decrypted for withdrawal detail view',
          ipAddress,
        });
      } catch (decryptErr) {
        this.logger.warn(
          `Failed to decrypt bank account number for withdrawal detail: ${(decryptErr as Error).message}`,
        );
      }
      let decryptedName = result.bankAccount.accountName;
      try {
        decryptedName = await decryptAES(result.bankAccount.accountName);
      } catch {
        /* pre-migration data */
      }
      result.bankAccount = {
        ...result.bankAccount,
        accountNumber: maskedNumber,
        accountName: decryptedName,
      };
    }

    return result;
  }

  async getFinancialSummary(): Promise<object> {
    // B-23 (audit-fix): use TZ-aware day/month boundaries instead of fixed
    // +07:00 offset arithmetic.
    //
    // WF-011 (dokumentasi): agregat fee platform (feeResult/feeToday/feeThisMonth)
    // HANYA menghitung order berstatus COMPLETED. Bila belum ada order selesai
    // (mis. order uji berstatus CANCELLED), kartu revenue memang menampilkan 0 —
    // perilaku benar, bukan bug. Pertimbangkan label "belum ada order selesai"
    // di UI admin bila kartu terlihat kosong.
    const todayStart = startOfDayWIB();
    const monthStart = toWIB().startOf('month').toDate();

    const [
      topupResult,
      withdrawResult,
      feeResult,
      feeToday,
      feeThisMonth,
      withdrawToday,
      escrowResult,
      pendingWithdrawResult,
      // WF-002: revenue langganan Kahade+ sebelumnya tidak dihitung di ringkasan
      // (hanya di endpoint getRevenue yang tak dipakai UI) — kartu "Revenue"
      // mengecilkan pendapatan. Agregat aditif; field lama tidak diubah.
      subRevenueAll,
      subRevenueToday,
      subRevenueThisMonth,
    ] = await Promise.all([
      this.prisma.walletTransaction.aggregate({
        where: { type: 'TOP_UP', status: 'SUCCESS' },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.walletTransaction.aggregate({
        where: { type: 'WITHDRAW', status: 'SUCCESS' },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.order.aggregate({
        where: { status: 'COMPLETED' },
        _sum: { feeAmount: true },
        _count: true,
      }),
      this.prisma.order.aggregate({
        where: { status: 'COMPLETED', completedAt: { gte: todayStart } },
        _sum: { feeAmount: true },
      }),
      this.prisma.order.aggregate({
        where: { status: 'COMPLETED', completedAt: { gte: monthStart } },
        _sum: { feeAmount: true },
      }),
      this.prisma.walletTransaction.aggregate({
        where: { type: 'WITHDRAW', status: 'SUCCESS', createdAt: { gte: todayStart } },
        _sum: { amount: true },
      }),
      this.prisma.wallet.aggregate({
        _sum: { escrowBalance: true },
      }),
      this.prisma.walletTransaction.aggregate({
        where: {
          type: 'WITHDRAW',
          withdrawStatus: { in: ['PENDING_OTP', 'PENDING_PROCESS', 'PROCESSING'] },
        },
        _sum: { amount: true },
        _count: true,
      }),
      // WF-002: pembayaran langganan sukses (basis createdAt, WIB day/month).
      this.prisma.walletTransaction.aggregate({
        where: { type: 'SUBSCRIPTION_PAYMENT', status: 'SUCCESS' },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.walletTransaction.aggregate({
        where: { type: 'SUBSCRIPTION_PAYMENT', status: 'SUCCESS', createdAt: { gte: todayStart } },
        _sum: { amount: true },
      }),
      this.prisma.walletTransaction.aggregate({
        where: { type: 'SUBSCRIPTION_PAYMENT', status: 'SUCCESS', createdAt: { gte: monthStart } },
        _sum: { amount: true },
      }),
    ]);

    // All BigInt amounts stored in sen — convert to IDR numbers for frontend display.
    const subAll = toIdr(subRevenueAll._sum.amount ?? BigInt(0));
    const subToday = toIdr(subRevenueToday._sum.amount ?? BigInt(0));
    const subThisMonth = toIdr(subRevenueThisMonth._sum.amount ?? BigInt(0));
    const feeTodayIdr = toIdr(feeToday._sum.feeAmount ?? BigInt(0));
    const feeThisMonthIdr = toIdr(feeThisMonth._sum.feeAmount ?? BigInt(0));
    return {
      totalTopup: toIdr(topupResult._sum.amount ?? BigInt(0)),
      totalTopupCount: topupResult._count,
      totalWithdrawal: toIdr(withdrawResult._sum.amount ?? BigInt(0)),
      totalWithdrawalCount: withdrawResult._count,
      totalFees: toIdr(feeResult._sum.feeAmount ?? BigInt(0)),
      totalFeeCount: feeResult._count,
      totalPlatformFeeToday: feeTodayIdr,
      totalPlatformFeeThisMonth: feeThisMonthIdr,
      totalWithdrawalsToday: toIdr(withdrawToday._sum.amount ?? BigInt(0)),
      totalEscrowBalance: toIdr(escrowResult._sum.escrowBalance ?? BigInt(0)),
      pendingWithdrawals: pendingWithdrawResult._count,
      pendingWithdrawalsAmount: toIdr(pendingWithdrawResult._sum.amount ?? BigInt(0)),
      // WF-002: breakdown langganan + revenue gabungan (fee + langganan).
      totalSubscriptionRevenue: subAll,
      totalSubscriptionRevenueCount: subRevenueAll._count,
      totalSubscriptionRevenueToday: subToday,
      totalSubscriptionRevenueThisMonth: subThisMonth,
      totalRevenueToday: feeTodayIdr + subToday,
      totalRevenueThisMonth: feeThisMonthIdr + subThisMonth,
    };
  }

  /**
   * CW-022: export CSV keuangan yang bisa dipakai rekonsiliasi — bukan cuma
   * ringkasan kasar. Isi: (1) ringkasan agregat, (2) breakdown HARIAN
   * (topup/withdrawal/fee + count) dalam rentang yang diminta. Semua angka
   * agregat — tanpa PII. Nilai dikutip (CSV-safe) dan nested object
   * di-flatten agar tidak ada sel JSON mentah.
   */
  async buildFinanceCsvExport(from: Date, to: Date): Promise<string> {
    const summary = (await this.getFinancialSummary()) as Record<string, unknown>;

    type DailyRow = { day: Date; total: bigint; cnt: bigint };
    const [topupDaily, withdrawDaily, feeDaily] = await Promise.all([
      this.prisma.$queryRaw<DailyRow[]>`
        SELECT date_trunc('day', "createdAt")::date AS day,
               COALESCE(SUM(amount), 0)::bigint AS total,
               COUNT(*)::bigint AS cnt
        FROM wallet_transactions
        WHERE type = 'TOP_UP' AND status = 'SUCCESS'
          AND "createdAt" >= ${from} AND "createdAt" <= ${to}
        GROUP BY 1 ORDER BY 1`,
      this.prisma.$queryRaw<DailyRow[]>`
        SELECT date_trunc('day', "createdAt")::date AS day,
               COALESCE(SUM(amount), 0)::bigint AS total,
               COUNT(*)::bigint AS cnt
        FROM wallet_transactions
        WHERE type = 'WITHDRAW' AND status = 'SUCCESS'
          AND "createdAt" >= ${from} AND "createdAt" <= ${to}
        GROUP BY 1 ORDER BY 1`,
      this.prisma.$queryRaw<DailyRow[]>`
        SELECT date_trunc('day', "completedAt")::date AS day,
               COALESCE(SUM("feeAmount"), 0)::bigint AS total,
               COUNT(*)::bigint AS cnt
        FROM orders
        WHERE status = 'COMPLETED'
          AND "completedAt" >= ${from} AND "completedAt" <= ${to}
        GROUP BY 1 ORDER BY 1`,
    ]);

    const dayKey = (d: Date | string): string =>
      d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
    const toMap = (rows: DailyRow[]): Map<string, DailyRow> =>
      new Map(rows.map((r) => [dayKey(r.day), r]));
    const topupMap = toMap(topupDaily);
    const withdrawMap = toMap(withdrawDaily);
    const feeMap = toMap(feeDaily);
    const allDays = [...new Set([...topupMap.keys(), ...withdrawMap.keys(), ...feeMap.keys()])].sort();

    const csvCell = (v: unknown): string => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines: string[] = [];
    lines.push(`# finance export generated_at=${new Date().toISOString()} range=${dayKey(from)}..${dayKey(to)} (WIB)`);
    lines.push('');
    lines.push('[summary]');
    lines.push('metric,value');
    for (const [k, v] of Object.entries(summary)) {
      // Flatten: tidak ada lagi sel JSON mentah (temuan CW-022).
      if (v !== null && typeof v === 'object') {
        for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
          lines.push(`${csvCell(`${k}.${sk}`)},${csvCell(sv)}`);
        }
      } else {
        lines.push(`${csvCell(k)},${csvCell(v)}`);
      }
    }
    lines.push('');
    lines.push('[daily]');
    lines.push('date,topup_idr,topup_count,withdrawal_idr,withdrawal_count,fee_idr,fee_count');
    for (const day of allDays) {
      const t = topupMap.get(day);
      const w = withdrawMap.get(day);
      const f = feeMap.get(day);
      lines.push(
        [
          day,
          t ? toIdr(t.total) : 0,
          t ? Number(t.cnt) : 0,
          w ? toIdr(w.total) : 0,
          w ? Number(w.cnt) : 0,
          f ? toIdr(f.total) : 0,
          f ? Number(f.cnt) : 0,
        ].map(csvCell).join(','),
      );
    }
    return lines.join('\n') + '\n';
  }

  async listPendingWithdrawals(
    page: number = 1,
    limit: number = 20,
    adminId: string,
    ipAddress: string = 'unknown',
  ): Promise<object> {
    const safeLimit = Math.min(limit, 100);
    const where: Prisma.WalletTransactionWhereInput = {
      type: 'WITHDRAW',
      withdrawStatus: { in: ['PENDING_OTP', 'PENDING_PROCESS', 'PROCESSING'] },
    };

    const [withdrawals, total] = await Promise.all([
      this.prisma.walletTransaction.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * safeLimit,
        take: safeLimit,
        include: {
          wallet: {
            select: {
              userId: true,
              user: { select: { userId: true, fullName: true, email: true } },
            },
          },
          bankAccount: {
            select: { id: true, bankCode: true, accountName: true, accountNumber: true },
          },
        },
      }),
      this.prisma.walletTransaction.count({ where }),
    ]);

    const serialized = await Promise.all(
      withdrawals.map(async tx => {
        let maskedAccountNumber: string | null = null;
        if (tx.bankAccount) {
          try {
            const plain = await decryptAES(tx.bankAccount.accountNumber);
            maskedAccountNumber = `****${plain.slice(-4)}`;
            this.auditLog.logAdminAction({
              adminId,
              action: AuditAction.ADMIN_ACTION,
              targetType: 'BankAccount',
              targetId: tx.bankAccount.id ?? 'unknown',
              description: 'Bank account number decrypted for withdrawal list view',
              ipAddress,
            });
          } catch {
            maskedAccountNumber = '****';
          }
        }
        let decryptedAccName = tx.bankAccount?.accountName ?? null;
        if (tx.bankAccount?.accountName) {
          try {
            decryptedAccName = await decryptAES(tx.bankAccount.accountName);
          } catch {
            /* pre-migration data */
          }
        }
        return {
          ...tx,
          amount: toIdr(tx.amount),
          balanceBefore: toIdr(tx.balanceBefore),
          balanceAfter: toIdr(tx.balanceAfter),
          bankAccount: tx.bankAccount
            ? {
                ...tx.bankAccount,
                accountNumber: maskedAccountNumber,
                accountName: decryptedAccName,
              }
            : tx.bankAccount,
        };
      }),
    );

    return createPaginatedResponse(serialized, total, page, safeLimit);
  }

  async approveWithdrawal(
    txId: string,
    dto: WithdrawalApproveDto,
    adminId: string,
    ipAddress: string = 'internal',
  ): Promise<object> {
    const adminNote = this.sanitizeAdminNote(dto.adminNote);
    // B-22 (audit-fix): lookup by public txId only -- the OR-by-internal-id
    // was permissive and meant attacker control over the URL parameter could
    // disambiguate via either column. Public txId is the documented contract.
    const tx = await this.prisma.walletTransaction.findFirst({
      where: { txId },
      include: { wallet: true, bankAccount: true },
    });

    if (!tx) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Transaction not found',
      });
    }

    if (tx.type !== 'WITHDRAW' || tx.withdrawStatus !== 'PENDING_PROCESS') {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_STATUS,
        message: 'Transaction is not a pending withdrawal',
      });
    }

    // B-03 (audit-fix): a withdrawal MUST have an attached bankAccount before
    // approval. Without this guard the function silently skipped the Iris
    // payout but still updated the description / audit-log to "approved",
    // leaving the user with no money sent and the operator believing payout
    // succeeded. Bank account can become null if the user soft-deleted it
    // between submission and admin review, or if a Prisma cascade nullified it.
    if (!tx.bankAccount) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_STATUS,
        message:
          'Withdrawal has no attached bank account -- cannot approve. Ask user to re-submit with a valid bank account.',
      });
    }

    const txUpdate = await this.prisma.walletTransaction.updateMany({
      where: {
        id: tx.id,
        withdrawStatus: 'PENDING_PROCESS',
      },
      data: {
        withdrawStatus: 'PROCESSING',
        description: `Processing by admin ${adminId} at ${new Date().toISOString()}`,
      },
    });

    if (txUpdate.count === 0) {
      throw new ConflictException({
        code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
        message: 'Withdrawal was already processed by another admin, please refresh',
      });
    }

    try {
      const plainAccountNumber = await decryptAES(tx.bankAccount.accountNumber);
      this.auditLog.logAdminAction({
        adminId,
        action: AuditAction.ADMIN_ACTION,
        targetType: 'BankAccount',
        targetId: tx.bankAccount.id ?? 'unknown',
        description: `Bank account number decrypted for payout processing (tx: ${tx.txId})`,
        ipAddress,
      });
      let beneficiaryName = tx.bankAccount.accountName;
      try {
        beneficiaryName = await decryptAES(tx.bankAccount.accountName);
      } catch {
        /* pre-migration data */
      }
      await this.midtransService.createIrisPayout({
        referenceNo: tx.txId,
        beneficiaryName,
        beneficiaryAccount: plainAccountNumber,
        beneficiaryBank: tx.bankAccount.bankCode,
        amount: toIdr(tx.amount),
      });

      await this.prisma.walletTransaction.update({
        where: { id: tx.id },
        data: {
          description: adminNote
            ? `Approved by admin ${adminId}: ${adminNote} — awaiting Iris confirmation`
            : `Approved by admin ${adminId} — awaiting Iris confirmation`,
        },
      });
    } catch (payoutError) {
      this.logger.error(
        `Payout failed for txId=${tx.txId ?? tx.id}: ${payoutError instanceof Error ? payoutError.message : String(payoutError)}`,
      );
      await this.prisma.walletTransaction.updateMany({
        where: { id: tx.id, withdrawStatus: 'PROCESSING' },
        data: {
          description: adminNote
            ? `Approved by admin ${adminId}: ${adminNote} — payout submission outcome pending reconciliation`
            : `Approved by admin ${adminId} — payout submission outcome pending reconciliation`,
        },
      });
      this.auditLog.logAdminAction({
        adminId,
        action: AuditAction.ADMIN_ACTION,
        targetType: 'WalletTransaction',
        targetId: tx.id,
        description: `Withdrawal payout submission could not be confirmed for ${tx.txId ?? tx.id}; retained in PROCESSING for Iris reconciliation`,
        ipAddress,
      });
      throw new ServiceUnavailableException({
        code: ErrorCodes.PAYOUT_FAILED,
        message:
          'Payout submission could not be confirmed. The withdrawal remains in processing while provider status is reconciled.',
      });
    }

    const updated = await this.prisma.walletTransaction.findUniqueOrThrow({ where: { id: tx.id } });

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'WalletTransaction',
      targetId: tx.id,
      description: `Approved withdrawal payout ${tx.txId ?? tx.id}`,
      ipAddress,
    });

    // AW-018: totalWalletBalance/totalEscrowBalance di summary bisa berubah.
    await this.dashboard.invalidateSummaryCache();

    return {
      ...updated,
      amount: toIdr(updated.amount),
      balanceBefore: toIdr(updated.balanceBefore),
      balanceAfter: toIdr(updated.balanceAfter),
    };
  }

  async rejectWithdrawal(
    txId: string,
    dto: WithdrawalRejectDto,
    adminId: string,
    ipAddress: string = 'internal',
  ): Promise<object> {
    const adminNote = this.sanitizeAdminNote(dto.adminNote);
    // B-22 (audit-fix): lookup by public txId only.
    const tx = await this.prisma.walletTransaction.findFirst({
      where: { txId },
      include: { wallet: true },
    });

    if (!tx) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Transaction not found',
      });
    }

    if (tx.type !== 'WITHDRAW' || tx.withdrawStatus !== 'PENDING_PROCESS') {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_STATUS,
        message: 'Transaction is not a pending withdrawal',
      });
    }

    const updated = await this.prisma.$transaction(
      async (ptx: Prisma.TransactionClient) => {
        const txClaim = await ptx.walletTransaction.updateMany({
          where: {
            id: tx.id,
            withdrawStatus: 'PENDING_PROCESS',
          },
          data: {
            withdrawStatus: 'FAILED',
            status: 'FAILED',
            description: adminNote
              ? `Rejected by admin ${adminId}: ${adminNote}`
              : `Rejected by admin ${adminId}`,
          },
        });

        if (txClaim.count === 0) {
          throw new ConflictException({
            code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
            message: 'Withdrawal was already processed by another admin, please refresh',
          });
        }

        const freshWallet = await ptx.wallet.findUnique({ where: { id: tx.walletId } });
        if (!freshWallet) {
          throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Wallet not found' });
        }

        const todayStart = startOfDayWIB();
        const isToday = tx.createdAt >= todayStart;

        const withdrawRollback = isToday
          ? freshWallet.todayWithdrawAmount >= tx.amount
            ? { decrement: tx.amount }
            : { set: BigInt(0) }
          : undefined;

        const walletUpdate = await ptx.wallet.updateMany({
          where: { id: tx.walletId, version: freshWallet.version },
          data: {
            availableBalance: { increment: tx.amount },
            totalBalance: { increment: tx.amount },
            ...(withdrawRollback !== undefined ? { todayWithdrawAmount: withdrawRollback } : {}),
            version: { increment: 1 },
          },
        });

        if (walletUpdate.count === 0) {
          throw new ConflictException({
            code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
            message: 'Wallet was modified concurrently, please retry',
          });
        }

        // WF-012: tulis entri ledger kompensasi untuk refund penolakan — riwayat
        // user sebelumnya hanya menunjukkan WITHDRAW FAILED tanpa baris kredit.
        // Saldo TIDAK diubah di sini (sudah di-increment di atas); entri ini
        // murni jejak audit. Tipe ADMIN_CREDIT = kredit yang diterbitkan admin
        // (preseden: adjustWallet, insurance payout); tipe WITHDRAW_REFUND
        // khusus butuh migrasi enum — dilaporkan, belum dikerjakan.
        // Basis totalBalance selaras dengan baris WITHDRAW saat request.
        const refundEntry = await ptx.walletTransaction.create({
          data: {
            txId: `${tx.txId ?? tx.id}-REFUND`,
            walletId: tx.walletId,
            type: WalletTransactionType.ADMIN_CREDIT,
            status: WalletTransactionStatus.SUCCESS,
            amount: tx.amount,
            balanceBefore: freshWallet.totalBalance,
            balanceAfter: freshWallet.totalBalance + tx.amount,
            description: `Withdrawal refund — rejected by admin ${adminId}${adminNote ? `: ${adminNote}` : ''}`,
            reversalTxId: tx.id,
            completedAt: new Date(),
          },
        });
        await ptx.walletTransaction.update({
          where: { id: tx.id },
          data: { reversalTxId: refundEntry.id },
        });

        return ptx.walletTransaction.findUniqueOrThrow({ where: { id: tx.id } });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'WalletTransaction',
      targetId: tx.id,
      description: `Rejected withdrawal ${tx.txId ?? tx.id} (refunded to user)${adminNote ? ': ' + adminNote : ''}`,
      ipAddress,
    });

    // AW-018: pendingWithdrawals di summary dashboard berubah.
    await this.dashboard.invalidateSummaryCache();

    return {
      ...updated,
      amount: toIdr(updated.amount),
      balanceBefore: toIdr(updated.balanceBefore),
      balanceAfter: toIdr(updated.balanceAfter),
    };
  }

  logReconciliation(adminId: string, userId: string, clean: boolean, ipAddress: string): void {
    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'Wallet',
      targetId: userId,
      description: `Admin reconciled wallet for user ${userId} — ${clean ? 'clean' : 'discrepancy found'}`,
      after: { clean },
      ipAddress,
    });
  }

  async getEscrowSummary(): Promise<{
    totalEscrowBalance: number;
    walletsWithEscrow: number;
    activeEscrowOrders: number;
  }> {
    const [escrowAgg, activeEscrowOrders] = await Promise.all([
      this.prisma.wallet.aggregate({
        where: { escrowBalance: { gt: 0 } },
        _sum: { escrowBalance: true },
        _count: true,
      }),
      this.prisma.order.count({
        where: { status: { in: ['PROCESSING', 'IN_DELIVERY', 'DISPUTED'] } },
      }),
    ]);

    return {
      totalEscrowBalance: toIdr(escrowAgg._sum.escrowBalance ?? BigInt(0)),
      walletsWithEscrow: escrowAgg._count,
      activeEscrowOrders,
    };
  }

  async getRevenue(): Promise<object> {
    const [feeResult, subscriptionResult, monthlyRevenue] = await Promise.all([
      this.prisma.order.aggregate({
        where: { status: 'COMPLETED' },
        _sum: { feeAmount: true },
        _count: true,
      }),
      this.prisma.walletTransaction.aggregate({
        where: { type: 'SUBSCRIPTION_PAYMENT', status: 'SUCCESS' },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.$queryRaw<Array<{ month: Date; total: bigint; count: bigint; source: string }>>`
        SELECT DATE_TRUNC('month', "completedAt") as month,
               COALESCE(SUM("feeAmount"), 0)::bigint as total,
               COUNT(*)::bigint as count,
               'fee'::text as source
        FROM orders
        WHERE status = 'COMPLETED'
          AND "completedAt" IS NOT NULL
        GROUP BY DATE_TRUNC('month', "completedAt")
        UNION ALL
        SELECT DATE_TRUNC('month', "createdAt") as month,
               COALESCE(SUM(amount), 0)::bigint as total,
               COUNT(*)::bigint as count,
               'subscription'::text as source
        FROM wallet_transactions
        WHERE type = 'SUBSCRIPTION_PAYMENT'
          AND status = 'SUCCESS'
        GROUP BY DATE_TRUNC('month', "createdAt")
        ORDER BY month DESC, source ASC
        LIMIT 48
      `,
    ]);

    // Convert BigInt sen amounts to IDR numbers for frontend display.
    const totalFeeRevenue = toIdr(feeResult._sum.feeAmount ?? BigInt(0));
    const totalSubscriptionRevenue = toIdr(subscriptionResult._sum.amount ?? BigInt(0));
    const totalRevenue = toIdr(
      (feeResult._sum.feeAmount ?? BigInt(0)) + (subscriptionResult._sum.amount ?? BigInt(0)),
    );

    return {
      totalRevenue,
      breakdown: {
        transactionFees: {
          total: totalFeeRevenue,
          count: feeResult._count,
        },
        subscriptionPayments: {
          total: totalSubscriptionRevenue,
          count: subscriptionResult._count,
        },
      },
      monthlyRevenue: monthlyRevenue.map(row => ({
        month: row.month,
        total: toIdr(row.total),
        count: Number(row.count),
        source: row.source,
      })),
    };
  }
}
