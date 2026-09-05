import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { OrderStatus, AuditAction } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { ReconciliationService } from '../../admin/finance/reconciliation.service';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { toIdr } from '../../../common/utils/currency.util';
import { formatWIBDate } from '../../../common/utils/date.util';

@Injectable()
export class WeeklyReconciliationService {
  private readonly logger = new Logger(WeeklyReconciliationService.name);

  constructor(
    private redis: RedisService,
    private prisma: PrismaService,
    private reconciliationService: ReconciliationService,
  ) {}

  // SCH-017/SCH-030: Runs at 03:00 WIB daily for wallet + escrow + fee reconciliation
  @Cron('0 3 * * *', { name: 'daily-reconciliation', timeZone: 'Asia/Jakarta' })
  async runDailyReconciliation(): Promise<void> {
    if (!(await ensureRedisAvailable(this.redis, 'daily-reconciliation'))) return;

    const dayKey = this.getDayKey();
    const lockKey = `cron_lock:daily_reconciliation:${dayKey}`;
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, 1800);
    if (!acquired) {
      this.logger.log('Daily reconciliation skipped — another instance already executing.');
      return;
    }

    const startedAt = Date.now();
    this.logger.log('Starting daily wallet reconciliation...');

    try {
      const result = await this.reconciliationService.reconcileAllWallets();

      const durationMs = Date.now() - startedAt;

      if (result.clean) {
        this.logger.log(
          `Daily reconciliation complete: ${result.walletsChecked} wallets checked, ` +
            `0 discrepancies found (${durationMs}ms)`,
        );
      } else {
        this.logger.warn(
          `Daily reconciliation ALERT: ${result.discrepancies.length} discrepancies found ` +
            `out of ${result.walletsChecked} wallets (${durationMs}ms)`,
        );

        for (const d of result.discrepancies) {
          this.logger.warn(
            `DISCREPANCY: wallet=${d.walletId} user=${d.userId} ` +
              `actual=${d.actualTotal} expected=${d.expectedTotal} ` +
              `diff=${d.discrepancy} invariantViolation=${d.invariantViolation}`,
          );
        }

        await this.alertAdminsOnMismatch(
          `Wallet Reconciliation Alert: ${result.discrepancies.length} discrepancies found`,
          `Daily reconciliation detected ${result.discrepancies.length} wallet balance discrepancies out of ${result.walletsChecked} checked. Immediate review required.`,
        );
      }

      await this.reconcileEscrowBalances();
      await this.reconcileFeeWallet();
      await this.reconcileStaleProcessingWithdrawals();

      // SCH-013/SCH-016: Store heartbeat for health check monitoring
      const totalDurationMs = Date.now() - startedAt;
      await this.redis
        .setex(
          `cron_heartbeat:daily_reconciliation`,
          86400,
          JSON.stringify({
            ranAt: new Date().toISOString(),
            walletsChecked: result.walletsChecked,
            discrepancies: result.discrepancies.length,
            clean: result.clean,
            durationMs: totalDurationMs,
          }),
        )
        .catch(err =>
          this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`),
        );

      // SCH-016: Alert on discrepancies via Redis key for external monitoring
      if (!result.clean) {
        await this.redis
          .setex(
            `cron_alert:reconciliation_discrepancy`,
            86400,
            JSON.stringify({
              alertAt: new Date().toISOString(),
              discrepancyCount: result.discrepancies.length,
              discrepancies: result.discrepancies.slice(0, 10),
            }),
          )
          .catch(err =>
            this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`),
          );
      }
    } catch (error) {
      this.logger.error(
        `Daily reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    } finally {
      await this.redis
        .releaseLock(lockKey, lockToken)
        .catch(err =>
          this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`),
        );
    }
  }

  private async reconcileEscrowBalances(): Promise<void> {
    try {
      const activeOrderStatuses: OrderStatus[] = ['PROCESSING', 'IN_DELIVERY', 'DISPUTED'];

      const allRelevantUserIds = new Set<string>();
      const BATCH_SIZE = 1000;
      let orderCursor: string | undefined;
      for (;;) {
        const orders = await this.prisma.order.findMany({
          where: { status: { in: activeOrderStatuses } },
          select: { id: true, buyerId: true },
          orderBy: { id: 'asc' },
          take: BATCH_SIZE,
          ...(orderCursor ? { cursor: { id: orderCursor }, skip: 1 } : {}),
        });
        for (const order of orders) allRelevantUserIds.add(order.buyerId);
        if (orders.length < BATCH_SIZE) break;
        orderCursor = orders[orders.length - 1].id;
      }

      let walletCursor: string | undefined;
      for (;;) {
        const wallets = await this.prisma.wallet.findMany({
          where: { escrowBalance: { gt: 0 } },
          select: { id: true, userId: true },
          orderBy: { id: 'asc' },
          take: BATCH_SIZE,
          ...(walletCursor ? { cursor: { id: walletCursor }, skip: 1 } : {}),
        });
        for (const wallet of wallets) allRelevantUserIds.add(wallet.userId);
        if (wallets.length < BATCH_SIZE) break;
        walletCursor = wallets[wallets.length - 1].id;
      }

      let escrowMismatches = 0;
      let walletsChecked = 0;

      for (const userId of allRelevantUserIds) {
        walletsChecked++;
        const wallet = await this.prisma.wallet.findFirst({
          where: { userId },
          select: { id: true, userId: true, escrowBalance: true },
        });
        if (!wallet) continue;

        const lockedOrders = await this.prisma.order.findMany({
          where: {
            buyerId: userId,
            status: { in: activeOrderStatuses },
          },
          select: { buyerPayAmount: true },
        });

        const expectedEscrow = lockedOrders.reduce((sum, o) => sum + o.buyerPayAmount, BigInt(0));

        if (wallet.escrowBalance !== expectedEscrow) {
          escrowMismatches++;
          this.logger.warn(
            `ESCROW MISMATCH: wallet=${wallet.id} user=${wallet.userId} ` +
              `actual=${toIdr(wallet.escrowBalance)} expected=${toIdr(expectedEscrow)} ` +
              `diff=${toIdr(wallet.escrowBalance - expectedEscrow)}`,
          );
        }
      }

      this.logger.log(
        `Escrow reconciliation: ${walletsChecked} wallets checked, ${escrowMismatches} mismatches`,
      );
      if (escrowMismatches > 0) {
        await this.alertAdminsOnMismatch(
          `Escrow Reconciliation Alert: ${escrowMismatches} mismatches`,
          `Escrow reconciliation found ${escrowMismatches} wallet(s) where escrow balance does not match active order totals. Immediate investigation required.`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Escrow reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async reconcileFeeWallet(): Promise<void> {
    try {
      const completedFeeResult = await this.prisma.order.aggregate({
        where: { status: 'COMPLETED' },
        _sum: { feeAmount: true },
        _count: true,
      });

      const feeDeductResult = await this.prisma.walletTransaction.aggregate({
        where: { type: 'FEE_DEDUCT', status: 'SUCCESS' },
        _sum: { amount: true },
        _count: true,
      });

      const expectedFees = completedFeeResult._sum.feeAmount ?? BigInt(0);
      const recordedFees = feeDeductResult._sum.amount ?? BigInt(0);

      if (expectedFees !== recordedFees) {
        const message =
          `FEE WALLET MISMATCH: expected total fees=${toIdr(expectedFees)} ` +
          `recorded FEE_DEDUCT total=${toIdr(recordedFees)} ` +
          `diff=${toIdr(expectedFees - recordedFees)} ` +
          `(orders=${completedFeeResult._count} feeDeducts=${feeDeductResult._count})`;
        this.logger.warn(message);
        await this.alertAdminsOnMismatch(
          'Fee reconciliation mismatch',
          `${message}. Immediate financial review required.`,
        );
      } else {
        this.logger.log(
          `Fee wallet reconciliation clean: ${toIdr(expectedFees)} total fees across ${completedFeeResult._count} orders`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Fee wallet reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async reconcileStaleProcessingWithdrawals(): Promise<void> {
    try {
      const staleThreshold = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const staleWithdrawals = await this.prisma.walletTransaction.findMany({
        where: {
          type: 'WITHDRAW',
          withdrawStatus: 'PROCESSING',
          updatedAt: { lt: staleThreshold },
        },
        select: {
          id: true,
          txId: true,
          walletId: true,
          amount: true,
          createdAt: true,
          updatedAt: true,
        },
        take: 1000,
      });

      if (staleWithdrawals.length === 0) {
        this.logger.log('Stale PROCESSING withdrawal reconciliation: 0 stale withdrawals found');
        return;
      }

      this.logger.warn(
        `STALE PROCESSING WITHDRAWALS: ${staleWithdrawals.length} withdrawal(s) stuck in PROCESSING for >2 hours. ` +
          `Manual verification with Iris required. TxIds: ${staleWithdrawals.map(w => w.txId).join(', ')}`,
      );
    } catch (err) {
      this.logger.error(
        `Stale PROCESSING withdrawal reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async alertAdminsOnMismatch(title: string, body: string): Promise<void> {
    try {
      const admins = await this.prisma.adminUser.findMany({
        where: { isActive: true, deletedAt: null, role: 'SUPER_ADMIN' },
        select: { id: true },
        take: 5,
      });
      if (admins.length === 0) {
        const fallback = await this.prisma.adminUser.findFirst({
          where: { isActive: true, deletedAt: null },
          select: { id: true },
        });
        if (fallback) admins.push(fallback);
      }
      for (const admin of admins) {
        await this.prisma.adminAuditLog
          .create({
            data: {
              adminId: admin.id,
              // AuditAction enum has no SYSTEM_RECONCILIATION; ADMIN_ACTION is the closest
              // generic bucket. Semantic info preserved in description (`[SYSTEM ALERT]` prefix).
              action: AuditAction.ADMIN_ACTION,
              targetType: 'Reconciliation',
              targetId: 'weekly-reconciliation',
              description: `[SYSTEM ALERT] ${title}: ${body}`,
              ipAddress: 'system',
            },
          })
          .catch(err =>
            this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`),
          );
      }
      this.logger.error(`[ADMIN ALERT] ${title}: ${body}`);
    } catch (err) {
      this.logger.error(
        `Failed to send admin mismatch alert: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private getDayKey(): string {
    return formatWIBDate();
  }
}
