import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { WalletTransactionStatus, WalletTransactionType, WithdrawStatus } from '@prisma/client';
import { toIdr } from '../../../common/utils/currency.util';
import { parseDateBoundaryWIB } from '../../../common/utils/date.util';

export interface WalletDiscrepancy {
  walletId: string;
  userId: string;
  actualAvailable: number;
  actualEscrow: number;
  actualTotal: number;
  expectedTotal: number;
  discrepancy: number;
  invariantViolation: boolean;
}

export interface ReconciliationResult {
  reconciledAt: string;
  walletsChecked: number;
  discrepancies: WalletDiscrepancy[];
  clean: boolean;
}

export interface AuditTrailRow {
  txId: string;
  type: string;
  status: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  totalBalanceDelta: number;
  runningTotalBalance: number;
  description: string;
  createdAt: Date;
}

export interface AuditTrailResult {
  userId: string;
  from: string;
  to: string;
  openingTotalBalance: number;
  closingTotalBalance: number;
  transactions: AuditTrailRow[];
}

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(private readonly prisma: PrismaService) {}

  async reconcileWalletBalance(userId: string): Promise<WalletDiscrepancy | null> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId },
      select: {
        id: true,
        userId: true,
        availableBalance: true,
        escrowBalance: true,
        totalBalance: true,
      },
    });

    if (!wallet) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Wallet not found for user' });
    }

    return this.reconcileWallet(wallet);
  }

  async reconcileAllWallets(): Promise<ReconciliationResult> {
    const BATCH_SIZE = 500;
    const discrepancies: WalletDiscrepancy[] = [];
    let totalChecked = 0;
    let lastId: string | null = null;

    for (;;) {
      const wallets: Array<{
        id: string;
        userId: string;
        availableBalance: bigint;
        escrowBalance: bigint;
        totalBalance: bigint;
      }> = await this.prisma.wallet.findMany({
        ...(lastId ? { cursor: { id: lastId }, skip: 1 } : {}),
        take: BATCH_SIZE,
        orderBy: { id: 'asc' as const },
        select: {
          id: true,
          userId: true,
          availableBalance: true,
          escrowBalance: true,
          totalBalance: true,
        },
      });

      if (wallets.length === 0) break;

      for (const wallet of wallets) {
        const result = await this.reconcileWallet(wallet);
        if (result) {
          discrepancies.push(result);
        }
      }

      totalChecked += wallets.length;
      lastId = wallets[wallets.length - 1].id;

      if (wallets.length < BATCH_SIZE) break;
    }

    return {
      reconciledAt: new Date().toISOString(),
      walletsChecked: totalChecked,
      discrepancies,
      clean: discrepancies.length === 0,
    };
  }

  async getFinancialAuditTrail(
    userId: string,
    from: string,
    to: string,
  ): Promise<AuditTrailResult> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId },
      select: { id: true },
    });

    if (!wallet) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Wallet not found for user' });
    }

    const fromDate = parseDateBoundaryWIB(from, 'start');
    const toDate = parseDateBoundaryWIB(to, 'end');
    if (!fromDate || !toDate) {
      throw new BadRequestException({
        code: 'INVALID_DATE_FORMAT',
        message: 'from and to must be valid ISO date strings',
      });
    }

    if (fromDate.getTime() > toDate.getTime()) {
      throw new BadRequestException({
        code: 'INVALID_DATE_RANGE',
        message: 'from must be before or equal to to',
      });
    }
    const diffDays = Math.ceil((toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays > 365) {
      throw new BadRequestException({
        code: 'DATE_RANGE_TOO_LARGE',
        message: 'Audit trail date range cannot exceed 365 days',
      });
    }

    const PRIOR_BATCH_SIZE = 5000;
    let openingTotalBalance = BigInt(0);
    let priorLastId: string | undefined;
    let priorLastCreatedAt: Date | undefined;

    for (;;) {
      const priorBatch = await this.prisma.walletTransaction.findMany({
        where: {
          walletId: wallet.id,
          status: WalletTransactionStatus.SUCCESS,
          createdAt: { lt: fromDate },
          ...(priorLastCreatedAt
            ? {
                OR: [
                  { createdAt: { gt: priorLastCreatedAt, lt: fromDate } },
                  { createdAt: priorLastCreatedAt, id: { gt: priorLastId } },
                ],
              }
            : {}),
        },
        take: PRIOR_BATCH_SIZE,
        orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
        select: { id: true, type: true, balanceBefore: true, balanceAfter: true, createdAt: true },
      });

      if (priorBatch.length === 0) break;

      for (const tx of priorBatch) {
        openingTotalBalance += this.computeTotalBalanceDelta(
          tx.type,
          tx.balanceBefore,
          tx.balanceAfter,
        );
      }

      priorLastId = priorBatch[priorBatch.length - 1].id;
      priorLastCreatedAt = priorBatch[priorBatch.length - 1].createdAt;
      if (priorBatch.length < PRIOR_BATCH_SIZE) break;
    }

    const RANGE_BATCH_SIZE = 5000;
    const rows: AuditTrailRow[] = [];
    let runningTotalBalance = openingTotalBalance;
    let rangeLastId: string | undefined;
    let rangeLastCreatedAt: Date | undefined;

    for (;;) {
      const batch = await this.prisma.walletTransaction.findMany({
        where: {
          walletId: wallet.id,
          status: WalletTransactionStatus.SUCCESS,
          createdAt: { gte: fromDate, lte: toDate },
          ...(rangeLastCreatedAt
            ? {
                OR: [
                  { createdAt: { gt: rangeLastCreatedAt } },
                  { createdAt: rangeLastCreatedAt, id: { gt: rangeLastId } },
                ],
              }
            : {}),
        },
        take: RANGE_BATCH_SIZE,
        orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
        select: {
          id: true,
          txId: true,
          type: true,
          status: true,
          amount: true,
          balanceBefore: true,
          balanceAfter: true,
          description: true,
          createdAt: true,
        },
      });

      if (batch.length === 0) break;

      for (const tx of batch) {
        const delta = this.computeTotalBalanceDelta(tx.type, tx.balanceBefore, tx.balanceAfter);
        runningTotalBalance += delta;

        rows.push({
          txId: tx.txId,
          type: tx.type,
          status: tx.status,
          amount: toIdr(tx.amount),
          balanceBefore: toIdr(tx.balanceBefore),
          balanceAfter: toIdr(tx.balanceAfter),
          totalBalanceDelta: toIdr(delta),
          runningTotalBalance: toIdr(runningTotalBalance),
          description: tx.description,
          createdAt: tx.createdAt,
        });
      }

      rangeLastId = batch[batch.length - 1].id;
      rangeLastCreatedAt = batch[batch.length - 1].createdAt;
      if (batch.length < RANGE_BATCH_SIZE) break;
    }

    return {
      userId,
      from,
      to,
      openingTotalBalance: toIdr(openingTotalBalance),
      closingTotalBalance: toIdr(runningTotalBalance),
      transactions: rows,
    };
  }

  private computeTotalBalanceDelta(
    type: WalletTransactionType,
    balanceBefore: bigint,
    balanceAfter: bigint,
  ): bigint {
    if (type === WalletTransactionType.ORDER_LOCK) {
      return BigInt(0);
    }
    return balanceAfter - balanceBefore;
  }

  private async reconcileWallet(wallet: {
    id: string;
    userId: string;
    availableBalance: bigint;
    escrowBalance: bigint;
    totalBalance: bigint;
  }): Promise<WalletDiscrepancy | null> {
    const BATCH_SIZE = 5000;
    let expectedTotal = BigInt(0);
    let lastId: string | undefined;

    for (;;) {
      const transactions = await this.prisma.walletTransaction.findMany({
        where: {
          walletId: wallet.id,
          OR: [
            { status: WalletTransactionStatus.SUCCESS },
            {
              type: WalletTransactionType.WITHDRAW,
              withdrawStatus: {
                in: [
                  WithdrawStatus.PENDING_OTP,
                  WithdrawStatus.PENDING_PROCESS,
                  WithdrawStatus.PROCESSING,
                ],
              },
            },
          ],
        },
        ...(lastId ? { cursor: { id: lastId }, skip: 1 } : {}),
        take: BATCH_SIZE,
        orderBy: { id: 'asc' as const },
        select: { id: true, type: true, balanceBefore: true, balanceAfter: true },
      });

      if (transactions.length === 0) break;

      for (const tx of transactions) {
        expectedTotal += this.computeTotalBalanceDelta(tx.type, tx.balanceBefore, tx.balanceAfter);
      }

      lastId = transactions[transactions.length - 1].id;
      if (transactions.length < BATCH_SIZE) break;
    }

    const invariantViolation =
      wallet.availableBalance + wallet.escrowBalance !== wallet.totalBalance;
    const balanceMismatch = wallet.totalBalance !== expectedTotal;

    if (!balanceMismatch && !invariantViolation) {
      return null;
    }

    return {
      walletId: wallet.id,
      userId: wallet.userId,
      actualAvailable: toIdr(wallet.availableBalance),
      actualEscrow: toIdr(wallet.escrowBalance),
      actualTotal: toIdr(wallet.totalBalance),
      expectedTotal: toIdr(expectedTotal),
      discrepancy: toIdr(wallet.totalBalance - expectedTotal),
      invariantViolation,
    };
  }
}
