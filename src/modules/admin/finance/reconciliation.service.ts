import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { WalletTransactionStatus, WalletTransactionType, WithdrawStatus } from '@prisma/client';
import { toIdr } from '../../../common/utils/currency.util';
import { parseDateBoundaryWIB } from '../../../common/utils/date.util';
import { resolveUserInternalId } from '../common/resolve-user-id';
import { mapWithConcurrency } from '../../../common/utils/bounded-concurrency.util';

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

export interface ReconcileBatchSnapshot {
  batchId: string;
  requestedBy: string;
  requestedAt: string;
  completedAt: string;
  walletsChecked: number;
  discrepanciesCount: number;
  urgentCount: number;
  clean: boolean;
}

const BATCH_SNAPSHOTS_KEY = 'reconciliation.batches';
const MAX_BATCH_SNAPSHOTS = 20;

// B1-006 (perf): checkpoint rekonsiliasi terakhir yang SUKSES. Incremental harian
// hanya memeriksa wallet yang bertransaksi sejak checkpoint; full scan mingguan.
const RECONCILIATION_CHECKPOINT_KEY = 'reconciliation.checkpoint';
/** B1-006: worker paralel untuk loop wallet (bounded — aman untuk pool DB 20). */
const RECONCILIATION_WALLET_CONCURRENCY = 6;
/** B1-006: full scan (semua wallet) tiap N hari; harian = incremental. */
const RECONCILIATION_FULL_SCAN_INTERVAL_DAYS = 7;
/** B1-006: bila checkpoint lebih tua dari ini, incremental tidak lagi hemat -> full scan. */
const RECONCILIATION_INCREMENTAL_MAX_AGE_DAYS = 30;

interface ReconciliationCheckpoint {
  lastFullRunAt: string | null;
  lastRunAt: string | null;
  lastMode: 'full' | 'incremental' | null;
}

type ReconcilableWallet = {
  id: string;
  userId: string;
  availableBalance: bigint;
  escrowBalance: bigint;
  totalBalance: bigint;
};

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * E3: simpan snapshot ringkasan batch agar tidak berubah saat dilihat
   * ulang (hasil job Bull bersifat sementara). Disimpan di system_configs
   * sebagai JSON (maks 20 batch terbaru).
   */
  async recordBatchSnapshot(
    batchId: string,
    requestedBy: string,
    requestedAt: string,
    result: ReconciliationResult,
    urgentCount = 0,
  ): Promise<ReconcileBatchSnapshot> {
    const snapshot: ReconcileBatchSnapshot = {
      batchId,
      requestedBy,
      requestedAt,
      completedAt: new Date().toISOString(),
      walletsChecked: result.walletsChecked,
      discrepanciesCount: result.discrepancies.length,
      urgentCount,
      clean: result.clean,
    };
    const existing = await this.prisma.systemConfig.findUnique({
      where: { key: BATCH_SNAPSHOTS_KEY },
      select: { value: true },
    });
    let snapshots: ReconcileBatchSnapshot[] = [];
    if (existing?.value) {
      try {
        const parsed = JSON.parse(existing.value) as ReconcileBatchSnapshot[];
        if (Array.isArray(parsed)) snapshots = parsed;
      } catch {
        snapshots = [];
      }
    }
    snapshots = [snapshot, ...snapshots.filter((s) => s.batchId !== batchId)].slice(0, MAX_BATCH_SNAPSHOTS);
    await this.prisma.systemConfig.upsert({
      where: { key: BATCH_SNAPSHOTS_KEY },
      create: {
        key: BATCH_SNAPSHOTS_KEY,
        value: JSON.stringify(snapshots),
        description: 'Snapshot ringkasan batch rekonsiliasi wallet (20 terbaru)',
      },
      update: { value: JSON.stringify(snapshots) },
    });
    return snapshot;
  }

  async listBatchSnapshots(): Promise<ReconcileBatchSnapshot[]> {
    const row = await this.prisma.systemConfig.findUnique({
      where: { key: BATCH_SNAPSHOTS_KEY },
      select: { value: true },
    });
    if (!row?.value) return [];
    try {
      const parsed = JSON.parse(row.value) as ReconcileBatchSnapshot[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async reconcileWalletBalance(userId: string): Promise<WalletDiscrepancy | null> {
    // ADM-203: terima ID publik (USR-…) maupun cuid internal.
    const internalUserId = await resolveUserInternalId(this.prisma, userId);
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId: internalUserId },
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

  /**
   * B1-006 (perf): rekonsiliasi semua wallet.
   *
   * - `mode: 'full'` (dipakai trigger manual admin): scan SEMUA wallet.
   * - `mode: 'incremental'`: hanya wallet yang bertransaksi sejak checkpoint
   *   sukses terakhir.
   * - `mode: 'auto'` (default, dipakai cron harian): incremental, kecuali belum
   *   pernah ada checkpoint atau full scan terakhir >= 7 hari -> full scan.
   *
   * Loop wallet diparalel bounded (6 worker). PERHITUNGAN per wallet
   * (reconcileWallet) TIDAK BERUBAH SAMA SEKALI — hanya cara eksekusinya.
   * Fail-closed: error di satu wallet menggagalkan run & checkpoint TIDAK
   * di-update, persis seperti perilaku loop berurutan lama.
   */
  async reconcileAllWallets(
    opts: { mode?: 'auto' | 'full' | 'incremental' } = {},
  ): Promise<ReconciliationResult> {
    const mode = opts.mode ?? 'auto';
    const checkpoint = await this.readCheckpoint();
    const runStartedAt = new Date();

    let full: boolean;
    if (mode === 'full') {
      full = true;
    } else if (mode === 'incremental') {
      full = false;
    } else {
      const lastFullMs = checkpoint.lastFullRunAt ? new Date(checkpoint.lastFullRunAt).getTime() : 0;
      full = Date.now() - lastFullMs >= RECONCILIATION_FULL_SCAN_INTERVAL_DAYS * 24 * 3600 * 1000;
    }

    let wallets: ReconcilableWallet[];
    let runMode: 'full' | 'incremental';
    if (full || !checkpoint.lastRunAt) {
      runMode = 'full';
      wallets = await this.listAllWallets();
    } else {
      const since = new Date(checkpoint.lastRunAt);
      const ageMs = runStartedAt.getTime() - since.getTime();
      if (ageMs > RECONCILIATION_INCREMENTAL_MAX_AGE_DAYS * 24 * 3600 * 1000) {
        // Checkpoint terlalu tua — incremental tidak lagi hemat.
        runMode = 'full';
        wallets = await this.listAllWallets();
      } else {
        runMode = 'incremental';
        wallets = await this.listActiveWalletsSince(since);
      }
    }

    this.logger.log(
      `reconcileAllWallets: mode=${runMode} (diminta: ${mode}), ${wallets.length} wallet, concurrency=${RECONCILIATION_WALLET_CONCURRENCY}`,
    );

    const results = await mapWithConcurrency(
      wallets,
      RECONCILIATION_WALLET_CONCURRENCY,
      (wallet) => this.reconcileWallet(wallet),
      { captureErrors: false },
    );
    const discrepancies: WalletDiscrepancy[] = [];
    for (const r of results) {
      if (r.ok && r.value) discrepancies.push(r.value);
    }

    // Checkpoint hanya di-update bila run SUKSES penuh (fail-closed).
    await this.writeCheckpoint({
      lastFullRunAt: runMode === 'full' ? runStartedAt.toISOString() : checkpoint.lastFullRunAt,
      lastRunAt: runStartedAt.toISOString(),
      lastMode: runMode,
    });

    return {
      reconciledAt: new Date().toISOString(),
      walletsChecked: wallets.length,
      discrepancies,
      clean: discrepancies.length === 0,
    };
  }

  /** B1-006: baca checkpoint terakhir yang sukses (null-safe). */
  private async readCheckpoint(): Promise<ReconciliationCheckpoint> {
    const empty: ReconciliationCheckpoint = { lastFullRunAt: null, lastRunAt: null, lastMode: null };
    try {
      const row = await this.prisma.systemConfig.findUnique({
        where: { key: RECONCILIATION_CHECKPOINT_KEY },
        select: { value: true },
      });
      if (!row?.value) return empty;
      const parsed = JSON.parse(row.value) as Partial<ReconciliationCheckpoint>;
      return {
        lastFullRunAt: typeof parsed.lastFullRunAt === 'string' ? parsed.lastFullRunAt : null,
        lastRunAt: typeof parsed.lastRunAt === 'string' ? parsed.lastRunAt : null,
        lastMode: parsed.lastMode === 'full' || parsed.lastMode === 'incremental' ? parsed.lastMode : null,
      };
    } catch {
      return empty;
    }
  }

  /** B1-006: tulis checkpoint (dipanggil hanya setelah run sukses). */
  private async writeCheckpoint(checkpoint: ReconciliationCheckpoint): Promise<void> {
    await this.prisma.systemConfig.upsert({
      where: { key: RECONCILIATION_CHECKPOINT_KEY },
      create: {
        key: RECONCILIATION_CHECKPOINT_KEY,
        value: JSON.stringify(checkpoint),
        description: 'Checkpoint rekonsiliasi wallet terakhir yang sukses (B1-006 incremental)',
      },
      update: { value: JSON.stringify(checkpoint) },
    });
  }

  /** B1-006: daftar SEMUA wallet (cursor pagination, batch 500). */
  private async listAllWallets(): Promise<ReconcilableWallet[]> {
    const BATCH_SIZE = 500;
    const wallets: ReconcilableWallet[] = [];
    let lastId: string | null = null;
    for (;;) {
      const batch: ReconcilableWallet[] = await this.prisma.wallet.findMany({
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
      if (batch.length === 0) break;
      wallets.push(...batch);
      lastId = batch[batch.length - 1].id;
      if (batch.length < BATCH_SIZE) break;
    }
    return wallets;
  }

  /**
   * B1-006: wallet yang punya transaksi (status apapun) sejak `since`.
   * Perubahan saldo SELALU tercatat sebagai walletTransaction di codebase ini,
   * jadi wallet tanpa transaksi baru tidak mungkin punya selisih baru vs
   * checkpoint terakhir. (Full scan mingguan tetap menangkap anomali apapun.)
   */
  private async listActiveWalletsSince(since: Date): Promise<ReconcilableWallet[]> {
    const active = await this.prisma.walletTransaction.findMany({
      where: { createdAt: { gte: since } },
      select: { walletId: true },
      distinct: ['walletId'],
    });
    if (active.length === 0) return [];
    return this.prisma.wallet.findMany({
      where: { id: { in: active.map((a) => a.walletId) } },
      select: {
        id: true,
        userId: true,
        availableBalance: true,
        escrowBalance: true,
        totalBalance: true,
      },
    });
  }

  async getFinancialAuditTrail(
    userId: string,
    from: string,
    to: string,
  ): Promise<AuditTrailResult> {
    // ADM-204: terima ID publik (USR-…) maupun cuid internal.
    const internalUserId = await resolveUserInternalId(this.prisma, userId);
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId: internalUserId },
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
      userId: internalUserId,
      from,
      to,
      openingTotalBalance: toIdr(openingTotalBalance),
      closingTotalBalance: toIdr(runningTotalBalance),
      transactions: rows,
    };
  }

  /**
   * WF-014: KONVENSI BASIS LEDGER (jangan diubah sembarangan).
   *
   * `balanceBefore`/`balanceAfter` BOLEH memakai basis komponen mana pun
   * (availableBalance / escrowBalance / totalBalance) ASALKAN
   * `balanceAfter - balanceBefore` == perubahan totalBalance akibat transaksi
   * (Δtotal = Δavailable + Δescrow). Semua tipe saat ini memenuhi ini.
   *
   * Pengecualian: transaksi yang hanya MEMINDAHKAN dana antar komponen tanpa
   * mengubah total (mis. ORDER_LOCK: available → escrow) HARUS dikembalikan 0
   * di sini — basis available-nya akan menghasilkan delta non-nol yang salah.
   * Tipe baru dengan pola serupa wajib ditambahkan ke pengecualian ini.
   */
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
