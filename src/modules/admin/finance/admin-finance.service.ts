import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  GoneException,
  NotImplementedException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { Prisma, AuditAction, WalletTransactionType, WalletTransactionStatus, OrderStatus, PaymentProvider, PaymentPurpose, PaymentStatus, EscrowDisbursementStatus, EscrowDisbursementScope } from '@prisma/client';
import { createPaginatedResponse } from '../../../common/dto/pagination.dto';
import { FinanceTransactionQueryDto } from './dto/finance-query.dto';
import { WithdrawalApproveDto, WithdrawalRejectDto } from './dto/withdrawal-action.dto';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { MidtransService } from '../../../modules/payment/midtrans.service';
import { WalletModeService } from '../../wallet-mode/wallet-mode.service';
import { decryptAES } from '../../../common/utils/crypto.util';
import { toIdr } from '../../../common/utils/currency.util';
import { parseDateBoundaryWIB, startOfDayWIB, toWIB } from '../../../common/utils/date.util';
import { DashboardService } from '../dashboard/dashboard.service';
import { maskSecretsDeep, toInitials } from './finance-secrets.util';
import { withCsvExportWatermark } from '../../../common/utils/csv-watermark.util';
import { URGENT_INVARIANT, buildFindingsWhereInput } from './reconciliation-findings.service';
import { FindingsQueryDto } from './dto/finance-findings.dto';

export type TimelineEventKind = 'LEDGER' | 'WEBHOOK' | 'PROVIDER' | 'REVERSAL';

export interface TimelineEventInput {
  at: Date | null | undefined;
  kind: TimelineEventKind;
  label: string;
  detail?: string | null;
}

export interface TimelineEvent {
  at: string;
  kind: TimelineEventKind;
  label: string;
  detail: string | null;
}

/**
 * AW-002 (perf-fix): peta tanda arus kas per tipe transaksi — CERMIRAN dari
 * `TX_META` di admin (`src/lib/tx-labels.ts`). WAJIB dijaga sinkron: bila tipe
 * baru ditambah di salah satu sisi, sisi lain harus ikut.
 * - '+' → dana MASUK ke wallet pengguna
 * - '−' → dana KELUAR dari wallet pengguna
 * - ''  → netral / tidak dikenal → DIKECUALIKAN dari agregat masuk/keluar
 *   (paritas dengan perilaku client-side lama).
 */
export const TX_AGGREGATE_SIGN: Record<string, '+' | '−' | ''> = {
  TOP_UP: '+',
  WITHDRAW: '−',
  ORDER_LOCK: '−',
  ORDER_RELEASE: '+',
  ORDER_REFUND: '+',
  FEE_DEDUCT: '−',
  REFERRAL_REWARD: '+',
  SUBSCRIPTION_PAYMENT: '−',
  ADMIN_CREDIT: '+',
  ADMIN_DEBIT: '−',
  DISPUTE_RELEASE: '+',
  TRANSFER_SENT: '−',
  TRANSFER_RECEIVED: '+',
  CAMPAIGN_CASHBACK: '+',
  TOPUP_BONUS: '+',
};

export interface FinanceTransactionAggregate {
  /** Total dana masuk (IDR) dari SEMUA transaksi yang cocok filter — tanpa clamp. */
  masuk: number;
  /** Total dana keluar (IDR) dari SEMUA transaksi yang cocok filter — tanpa clamp. */
  keluar: number;
  /** masuk - keluar. */
  bersih: number;
  /** Jumlah transaksi yang cocok filter (termasuk tipe netral/tak dikenal). */
  count: number;
}

/**
 * ADM-205 — dual control untuk approve withdrawal (maker-checker) [LEGACY].
 *
 * BAI-041 (P0, 2026-10-01): jalur approve withdrawal legacy DI-SUNSET —
 * approveWithdrawal() kini melempar 410 GONE (IRIS_PAYOUT_SUNSET) dan TIDAK
 * LAGI mengeksekusi payout ke provider mana pun. DANA Enterprise adalah
 * satu-satunya provider; pencairan dana tercatat di EscrowDisbursement
 * (GET /v1/admin/finance/disbursements). Komentar di bawah ini adalah
 * dokumentasi historis alur lama dan tidak lagi berlaku.
 *
 * Sebelum perbaikan ini, SATU admin FINANCE_ADMIN bisa menyetujui penarikan
 * berapa pun nominalnya dan langsung memicu payout Iris nyata. Sekarang dua
 * admin BERBEDA wajib menyetujui sebelum payout dieksekusi.
 *
 * Desain tanpa schema baru: tiap persetujuan dicatat sebagai baris append-only
 * di `admin_audit_logs` (action WITHDRAWAL_APPROVED, targetType
 * 'WithdrawalApproval', targetId = id internal WalletTransaction). Kuorum
 * dihitung dari DISTINCT adminId — satu admin tidak bisa menyetujui dua kali.
 *
 * Threshold configurable (open question produk — nilai final belum diputuskan):
 * SystemConfig `withdrawal.dual_approval_threshold_idr`. Bila key tidak ada /
 * tidak valid → FAIL-CLOSED: SEMUA nominal butuh 2 approval.
 */
export const WITHDRAWAL_APPROVAL_TARGET_TYPE = 'WithdrawalApproval';
export const WITHDRAWAL_DUAL_APPROVAL_THRESHOLD_KEY = 'withdrawal.dual_approval_threshold_idr';

export interface WithdrawalApprovalInfo {
  approvals: number;
  requiredApprovals: number;
  approvedByMe: boolean;
}

/**
 * E3: gabung + urutkan event timeline secara kronologis menaik
 * (fungsi murni — di-unit-test terpisah).
 */
export function buildSortedTimeline(inputs: TimelineEventInput[]): TimelineEvent[] {
  const withDates = inputs.filter((i): i is TimelineEventInput & { at: Date } => !!i.at);
  withDates.sort((a, b) => a.at.getTime() - b.at.getTime() || a.kind.localeCompare(b.kind));
  return withDates.map((e) => ({
    at: (e.at as Date).toISOString(),
    kind: e.kind,
    label: e.label,
    detail: e.detail ?? null,
  }));
}

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
    // BAI-041/047: mode wallet (opsional agar konstruksi manual di test lama
    // tetap jalan; DI-inject via WalletModeModule di runtime).
    @Optional() private readonly walletMode?: WalletModeService,
  ) {}

  /**
   * ADM-205 — guard murni (unit-testable): berapa approval berbeda yang
   * dibutuhkan untuk nominal tertentu.
   * - threshold null/tidak valid/<=0 → 2 (FAIL-CLOSED default).
   * - threshold > 0: nominal <= threshold → 1, di atasnya → 2.
   */
  static requiredWithdrawalApprovals(amountIdr: number, thresholdIdr: number | null): number {
    if (thresholdIdr === null || !Number.isFinite(thresholdIdr) || thresholdIdr <= 0) {
      return 2;
    }
    return amountIdr <= thresholdIdr ? 1 : 2;
  }

  /** ADM-205: baca threshold dual-approval; null = belum dikonfigurasi (fail-closed). */
  private async getWithdrawalDualApprovalThresholdIdr(): Promise<number | null> {
    try {
      const row = await this.prisma.systemConfig.findUnique({
        where: { key: WITHDRAWAL_DUAL_APPROVAL_THRESHOLD_KEY },
        select: { value: true },
      });
      if (!row) return null;
      const parsed = Number(String(row.value).trim());
      if (!Number.isFinite(parsed) || parsed < 0) return null;
      return Math.trunc(parsed);
    } catch (error) {
      // Fail-closed: bila config tidak bisa dibaca, anggap belum dikonfigurasi
      // → semua nominal butuh dual approval.
      this.logger.warn(`Gagal membaca ${WITHDRAWAL_DUAL_APPROVAL_THRESHOLD_KEY}; fail-closed ke dual approval: ${(error as Error).message}`);
      return null;
    }
  }

  /** ADM-205: daftar DISTINCT adminId yang sudah menyetujui withdrawal ini. */
  private async getWithdrawalApproverIds(txInternalId: string): Promise<string[]> {
    const rows = await this.prisma.adminAuditLog.findMany({
      where: {
        action: AuditAction.WITHDRAWAL_APPROVED,
        targetType: WITHDRAWAL_APPROVAL_TARGET_TYPE,
        targetId: txInternalId,
      },
      select: { adminId: true },
    });
    return [...new Set(rows.map((r) => r.adminId))];
  }

  /**
   * SYS-B-504 — decrypt lalu mask, pola sama seperti `maskDecrypt` di
   * admin-disbursement.service.ts: nama pemilik rekening TIDAK PERNAH
   * dikembalikan full ke view list/detail; gagal decrypt → '****'
   * (fail-closed, bukan bocor).
   */
  private async maskDecrypt(cipher: string | null | undefined): Promise<string> {
    if (!cipher) return '****';
    try {
      const plain = await decryptAES(cipher);
      return plain.length <= 4 ? '****' : `****${plain.slice(-4)}`;
    } catch {
      return '****';
    }
  }

  /**
   * AW-002 (perf-fix): bangun filter `where` transaksi dari DTO — dipakai
   * BERSAMA oleh `listTransactions` dan `getTransactionsAggregate` agar
   * agregat selalu memakai filter yang SAMA persis dengan tabel.
   */
  private buildTransactionListFilter(query: FinanceTransactionQueryDto): {
    where: Prisma.WalletTransactionWhereInput;
    start: Date;
    end: Date;
  } {
    const { type, status, startDate, endDate, q } = query;

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
    where.createdAt = { gte: start, lte: end };

    // WF-013: pencarian server-side — digabung AND dengan filter lain.
    // E3: cakupan diperluas ke referensi eksternal (midtransOrderId,
    // flashTransactionId, irisPayoutId, irisRef).
    const search = (q ?? '').trim().slice(0, 100);
    if (search) {
      where.OR = [
        { txId: { contains: search } },
        { description: { contains: search, mode: 'insensitive' } },
        { order: { orderId: { contains: search } } },
        { paymentTx: { midtransOrderId: { contains: search, mode: 'insensitive' } } },
        { paymentTx: { flashTransactionId: { contains: search, mode: 'insensitive' } } },
        { irisPayoutId: { contains: search } },
        { irisRef: { contains: search } },
      ];
    }

    return { where, start, end };
  }

  async listTransactions(query: FinanceTransactionQueryDto): Promise<object> {
    const { page = 1, limit = 20 } = query;
    const safePage = Number.isInteger(page) && page > 0 ? page : 1;
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;

    const { where } = this.buildTransactionListFilter(query);

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

  /**
   * AW-002 (perf-fix): agregat masuk/keluar server-side untuk halaman Keuangan.
   *
   * Menggantikan pola lama "fetch massal (limit besar) lalu jumlahkan di
   * browser" yang SALAH DIAM-DIAM karena backend meng-clamp limit ke 100.
   * Agregat dihitung di SQL (`GROUP BY type` + SUM) dari SEMUA baris yang
   * cocok filter — tanpa clamp, tanpa fetch baris.
   *
   * Klasifikasi masuk/keluar memakai `TX_AGGREGATE_SIGN` (cermin TX_META
   * frontend): tipe bertanda '' dikecualikan dari masuk/keluar tetapi tetap
   * dihitung di `count` — paritas dengan perilaku client-side lama.
   *
   * FAIL-CLOSED: tidak ada fallback/tebakan — bila query gagal, exception
   * dilempar dan admin menampilkan indikator error, BUKAN angka salah.
   */
  async getTransactionsAggregate(query: FinanceTransactionQueryDto): Promise<FinanceTransactionAggregate> {
    const { where } = this.buildTransactionListFilter(query);

    const [groups, count] = await Promise.all([
      this.prisma.walletTransaction.groupBy({
        by: ['type'],
        where,
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.walletTransaction.count({ where }),
    ]);

    let masukSen = 0n;
    let keluarSen = 0n;
    for (const g of groups) {
      const sumSen = g._sum.amount ?? 0n;
      const sign = TX_AGGREGATE_SIGN[g.type];
      if (sign === '+') masukSen += sumSen;
      else if (sign === '−') keluarSen += sumSen;
      // sign '' / tipe tak dikenal: dikecualikan dari masuk/keluar (paritas lama).
    }

    const masuk = toIdr(masukSen);
    const keluar = toIdr(keluarSen);
    return { masuk, keluar, bersih: masuk - keluar, count };
  }

  async getTransactionDetail(
    txId: string,
    adminId: string,
    ipAddress: string = 'unknown',
  ): Promise<object> {
    const detail = await this.buildTransactionDetail(txId, adminId, ipAddress);

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.FINANCE_TRANSACTION_VIEWED,
      targetType: 'WalletTransaction',
      targetId: (detail as { id: string }).id,
      description: `Viewed transaction detail ${(detail as { txId: string }).txId}`,
      ipAddress,
    });

    return detail;
  }

  private async buildTransactionDetail(
    txId: string,
    adminId: string,
    ipAddress: string = 'unknown',
  ): Promise<object> {
    // B-22 (audit-fix): lookup by public txId only.
    // E3 (G326-G350): audit kebocoran secret — metadata & payload webhook
    // di-mask; tambah relasi order/topup, status provider, referensi
    // eksternal, dan webhook terkait.
    const tx = await this.prisma.walletTransaction.findFirst({
      where: { txId },
      include: {
        wallet: {
          select: {
            userId: true,
            user: { select: { userId: true, fullName: true, email: true } },
          },
        },
        order: {
          select: {
            id: true,
            orderId: true,
            status: true,
            buyerId: true,
            sellerId: true,
            // E3: schema Order kini memakai orderValue/buyerPayAmount/
            // sellerReceiveAmount (totalAmount dihapus worker lain).
            orderValue: true,
            buyerPayAmount: true,
            sellerReceiveAmount: true,
            createdAt: true,
          },
        },
        bankAccount: {
          select: { id: true, bankCode: true, accountName: true, accountNumber: true },
        },
        paymentTx: {
          select: {
            id: true,
            midtransOrderId: true,
            provider: true,
            purpose: true,
            method: true,
            status: true,
            fraudStatus: true,
            vaNumber: true,
            vaBank: true,
            flashTransactionId: true,
            webhookReceivedAt: true,
            webhookPayload: true,
            paidAt: true,
            settledAt: true,
            failedAt: true,
            expiredAt: true,
            createdAt: true,
          },
        },
        reversalTx: {
          select: { id: true, txId: true, type: true, status: true, amount: true, createdAt: true },
        },
        reversals: {
          select: { id: true, txId: true, type: true, status: true, amount: true, createdAt: true },
        },
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
      // E3: metadata mentah TIDAK PERNAH dikembalikan tanpa masking —
      // berpotensi menyimpan secret provider (server key, signature, token).
      metadata: maskSecretsDeep(tx.metadata),
    };

    if (result.bankAccount) {
      let maskedNumber = '****';
      try {
        const plain = await decryptAES(result.bankAccount.accountNumber);
        maskedNumber = `****${plain.slice(-4)}`;
        this.auditLog.logAdminAction({
          adminId,
          action: AuditAction.BANK_ACCOUNT_NUMBER_ACCESSED,
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
      // SYS-B-504: nama pemilik rekening di-mask seperti nomornya (pola
      // maskDecrypt admin-disbursement) — full name tidak dikembalikan ke
      // view detail; akses nomor penuh tetap di-audit-log di atas.
      const maskedName = await this.maskDecrypt(result.bankAccount.accountName);
      result.bankAccount = {
        ...result.bankAccount,
        accountNumber: maskedNumber,
        accountName: maskedName,
      };
    }

    // Referensi eksternal provider (ID korelasi, bukan secret).
    const externalRefs = {
      midtransOrderId: tx.paymentTx?.midtransOrderId ?? null,
      irisPayoutId: tx.irisPayoutId ?? null,
      irisRef: tx.irisRef ?? null,
      flashTransactionId: tx.paymentTx?.flashTransactionId ?? null,
      vaNumber: tx.paymentTx?.vaNumber ?? null,
      vaBank: tx.paymentTx?.vaBank ?? null,
    };

    // Status provider dari sisi payment transaction.
    const providerStatus = tx.paymentTx
      ? {
          provider: tx.paymentTx.provider,
          status: tx.paymentTx.status,
          fraudStatus: tx.paymentTx.fraudStatus,
          webhookReceivedAt: tx.paymentTx.webhookReceivedAt,
          paidAt: tx.paymentTx.paidAt,
          settledAt: tx.paymentTx.settledAt,
          failedAt: tx.paymentTx.failedAt,
          expiredAt: tx.paymentTx.expiredAt,
        }
      : null;

    const webhooks = await this.findRelatedWebhooks(externalRefs);

    // E3: BigInt (sen) di relasi order/reversal WAJIB dikonversi ke number
    // IDR — JSON.stringify melempar TypeError untuk BigInt.
    const order = tx.order
      ? {
          ...tx.order,
          orderValue: toIdr(tx.order.orderValue),
          buyerPayAmount: toIdr(tx.order.buyerPayAmount),
          sellerReceiveAmount: toIdr(tx.order.sellerReceiveAmount),
        }
      : null;
    const reversalTx = tx.reversalTx
      ? { ...tx.reversalTx, amount: toIdr(tx.reversalTx.amount) }
      : null;
    const reversals = (tx.reversals ?? []).map((r) => ({
      ...r,
      amount: toIdr(r.amount),
    }));

    return {
      ...result,
      owner: tx.wallet?.user ?? null,
      order,
      reversalTx,
      reversals,
      externalRefs,
      providerStatus,
      webhooks,
      // paymentTx dengan payload webhook yang sudah di-mask.
      paymentTx: tx.paymentTx
        ? { ...tx.paymentTx, webhookPayload: maskSecretsDeep(tx.paymentTx.webhookPayload) }
        : null,
    };
  }

  /**
   * E3: webhook terkait sebuah transaksi — dicocokkan lewat
   * `payload->>'order_id'` (= midtransOrderId) atau transactionId provider
   * (= iris payout/ref). Payload di-mask dari secret.
   */
  private async findRelatedWebhooks(externalRefs: {
    midtransOrderId: string | null;
    irisPayoutId: string | null;
    irisRef: string | null;
  }): Promise<Array<Record<string, unknown>>> {
    const refValues = [externalRefs.midtransOrderId, externalRefs.irisPayoutId, externalRefs.irisRef].filter(
      (v): v is string => !!v,
    );
    if (refValues.length === 0) return [];
    type WebhookRow = {
      id: string;
      source: string;
      event: string;
      isProcessed: boolean;
      processedAt: Date | null;
      errorMessage: string | null;
      retryCount: number;
      createdAt: Date;
      payload: unknown;
    };
    const rows = await this.prisma.$queryRaw<WebhookRow[]>`
      SELECT id, source, event, "isProcessed", "processedAt", "errorMessage", "retryCount", "createdAt", payload
      FROM webhook_logs
      WHERE payload->>'order_id' = ANY(${refValues}::text[])
         OR "transactionId" = ANY(${refValues}::text[])
      ORDER BY "createdAt" DESC
      LIMIT 50`;
    return rows.map((r) => ({ ...r, payload: maskSecretsDeep(r.payload) }));
  }

  /**
   * E3: timeline gabungan event ledger + webhook untuk satu transaksi,
   * terurut waktu menaik.
   */
  async getTransactionTimeline(txId: string, adminId: string, ipAddress: string = 'unknown'): Promise<object> {
    const detail = (await this.buildTransactionDetail(txId, adminId, ipAddress)) as {
      id: string;
      txId: string;
      type: string;
      status: string;
      createdAt: Date;
      completedAt: Date | null;
      failureReason: string | null;
      reversalTx: { txId: string; createdAt: Date } | null;
      reversals: Array<{ txId: string; createdAt: Date; type: string }>;
      paymentTx: {
        status: string;
        webhookReceivedAt: Date | null;
        paidAt: Date | null;
        settledAt: Date | null;
        failedAt: Date | null;
        expiredAt: Date | null;
        createdAt: Date;
      } | null;
      webhooks: Array<{
        id: string;
        source: string;
        event: string;
        isProcessed: boolean;
        createdAt: Date;
        errorMessage: string | null;
      }>;
    };

    const inputs: TimelineEventInput[] = [];
    const push = (at: Date | null | undefined, kind: TimelineEventKind, label: string, detail?: string | null) => {
      inputs.push({ at, kind, label, detail: detail ?? null });
    };

    push(detail.createdAt, 'LEDGER', `Transaksi ${detail.txId} dibuat`, `type=${detail.type} status=${detail.status}`);
    if (detail.paymentTx) {
      const p = detail.paymentTx;
      push(p.createdAt, 'PROVIDER', 'Payment transaction dibuat', `status=${p.status}`);
      push(p.webhookReceivedAt, 'WEBHOOK', 'Webhook provider diterima', `status=${p.status}`);
      push(p.paidAt, 'PROVIDER', 'Pembayaran diterima provider');
      push(p.settledAt, 'PROVIDER', 'Dana settlement dari provider');
      push(p.failedAt, 'PROVIDER', 'Pembayaran gagal/kedaluwarsa di provider');
      push(p.expiredAt, 'PROVIDER', 'Payment transaction kedaluwarsa');
    }
    for (const w of detail.webhooks ?? []) {
      push(
        w.createdAt,
        'WEBHOOK',
        `${w.source}: ${w.event}`,
        w.isProcessed ? 'diproses' : w.errorMessage ? `gagal: ${w.errorMessage.slice(0, 200)}` : 'belum diproses',
      );
    }
    push(detail.completedAt, 'LEDGER', `Transaksi ${detail.status}`, detail.failureReason ?? undefined);
    if (detail.reversalTx) {
      push(detail.reversalTx.createdAt, 'REVERSAL', `Reversal oleh ${detail.reversalTx.txId}`);
    }
    for (const r of detail.reversals ?? []) {
      push(r.createdAt, 'REVERSAL', `Reversal ${r.txId}`, `type=${r.type}`);
    }

    const events = buildSortedTimeline(inputs);

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.FINANCE_TRANSACTION_VIEWED,
      targetType: 'WalletTransaction',
      targetId: detail.id,
      description: `Viewed transaction timeline ${detail.txId}`,
      ipAddress,
    });

    return {
      txId: detail.txId,
      events,
    };
  }

  /**
   * E3: ekspor CSV laporan rekonsiliasi TANPA PII — identitas pengguna hanya
   * inisial (tanpa userId/email/nomor telepon).
   *
   * BAD-020: ekspor WAJIB memakai filter yang sama dengan list
   * (buildFindingsWhereInput) — admin mendapat CSV yang sama dengan
   * daftar yang sedang dilihatnya.
   */
  // ADM-429: exporterAdminId dipakai untuk watermark keterlacakan di baris awal CSV.
  async buildFindingsCsvExport(exporterAdminId: string, query: FindingsQueryDto = {}): Promise<string> {
    const findings = await this.prisma.reconciliationFinding.findMany({
      where: buildFindingsWhereInput(query),
      orderBy: { createdAt: 'desc' },
      take: 5000,
    });
    const userIds = [...new Set(findings.map((f) => f.userId))];
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, fullName: true },
        })
      : [];
    const nameById = new Map(users.map((u) => [u.id, u.fullName]));

    const csvCell = (v: unknown): string => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines: string[] = [];
    lines.push(`# reconciliation findings export generated_at=${new Date().toISOString()} (WIB) — tanpa PII`);
    lines.push(
      'finding_id,inisial_pengguna,status,saldo_tercatat_idr,saldo_hitung_ulang_idr,selisih_idr,urgent,invariant_dilanggar,umur_hari,dibuat_pada',
    );
    for (const f of findings) {
      const ageDays = Math.floor((Date.now() - f.createdAt.getTime()) / (24 * 3600 * 1000));
      lines.push(
        [
          f.id,
          toInitials(nameById.get(f.userId)),
          f.status,
          toIdr(f.recordedBalance),
          toIdr(f.computedBalance),
          toIdr(f.difference),
          f.violatedInvariants.includes(URGENT_INVARIANT) ? 'YA' : 'TIDAK',
          f.violatedInvariants.join('|'),
          ageDays,
          f.createdAt.toISOString(),
        ]
          .map(csvCell)
          .join(','),
      );
    }
    // ADM-429: watermark pengekspor di baris awal CSV untuk keterlacakan kebocoran.
    return withCsvExportWatermark(lines.join('\n') + '\n', exporterAdminId, 'admin/finance/reconcile-findings/export');
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
   * BAD-033: ekspor CSV DAFTAR TRANSAKSI (bukan ringkasan agregat) —
   * menghormati filter aktif yang SAMA dengan list (type/status/q +
   * startDate/endDate wajib) via buildTransactionListFilter (AW-002).
   *
   * Admin yang memfilter "hanya WITHDRAWAL gagal" lalu mengekspor kini
   * menerima tepat baris yang difilter, bukan seluruh ledger.
   * PII minimal: userId internal + nama lengkap (tanpa email/telepon).
   */
  // ADM-429: exporterAdminId dipakai untuk watermark keterlacakan di baris awal CSV.
  async buildTransactionCsvExport(query: FinanceTransactionQueryDto, exporterAdminId: string): Promise<string> {
    const { where, start, end } = this.buildTransactionListFilter(query);
    const rows = await this.prisma.walletTransaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 5000,
      select: {
        txId: true,
        type: true,
        status: true,
        amount: true,
        balanceBefore: true,
        balanceAfter: true,
        description: true,
        createdAt: true,
        wallet: { select: { user: { select: { userId: true, fullName: true } } } },
        order: { select: { orderId: true } },
      },
    });
    const csvCell = (v: unknown): string => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const dayKey = (d: Date): string => d.toISOString().slice(0, 10);
    const lines: string[] = [];
    lines.push(
      `# finance transactions export generated_at=${new Date().toISOString()} ` +
        `range=${dayKey(start)}..${dayKey(end)} ` +
        `filters=${JSON.stringify({ type: query.type ?? null, status: query.status ?? null, q: query.q ?? null })}`,
    );
    lines.push('tx_id,dibuat_pada,tipe,status,jumlah_idr,saldo_sebelum_idr,saldo_sesudah_idr,deskripsi,order_publik,user_id,nama_pengguna');
    for (const r of rows) {
      lines.push(
        [
          r.txId,
          r.createdAt.toISOString(),
          r.type,
          r.status,
          toIdr(r.amount),
          toIdr(r.balanceBefore),
          toIdr(r.balanceAfter),
          r.description ?? '',
          r.order?.orderId ?? '',
          r.wallet?.user?.userId ?? '',
          r.wallet?.user?.fullName ?? '',
        ]
          .map(csvCell)
          .join(','),
      );
    }
    return withCsvExportWatermark(lines.join('\n') + '\n', exporterAdminId, 'admin/finance/export');
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

    // ADM-205: info kuorum dual approval per baris — satu query untuk semua id
    // (tanpa N+1) agar UI bisa menampilkan "1/2 persetujuan" & menonaktifkan
    // tombol bagi admin yang sudah menyetujui.
    const dualThresholdIdr = await this.getWithdrawalDualApprovalThresholdIdr();
    const approvalRows = withdrawals.length
      ? await this.prisma.adminAuditLog.findMany({
          where: {
            action: AuditAction.WITHDRAWAL_APPROVED,
            targetType: WITHDRAWAL_APPROVAL_TARGET_TYPE,
            targetId: { in: withdrawals.map((w) => w.id) },
          },
          select: { targetId: true, adminId: true },
        })
      : [];
    const approversByTx = new Map<string, Set<string>>();
    for (const row of approvalRows) {
      if (!row.targetId) continue;
      let set = approversByTx.get(row.targetId);
      if (!set) {
        set = new Set<string>();
        approversByTx.set(row.targetId, set);
      }
      set.add(row.adminId);
    }

    const serialized = await Promise.all(
      withdrawals.map(async tx => {
        let maskedAccountNumber: string | null = null;
        if (tx.bankAccount) {
          try {
            const plain = await decryptAES(tx.bankAccount.accountNumber);
            maskedAccountNumber = `****${plain.slice(-4)}`;
            this.auditLog.logAdminAction({
              adminId,
              action: AuditAction.BANK_ACCOUNT_NUMBER_ACCESSED,
              targetType: 'BankAccount',
              targetId: tx.bankAccount.id ?? 'unknown',
              description: 'Bank account number decrypted for withdrawal list view',
              ipAddress,
            });
          } catch {
            maskedAccountNumber = '****';
          }
        }
        // SYS-B-504: nama pemilik rekening di-mask di list (pola maskDecrypt
        // admin-disbursement) — full name tidak dikembalikan per baris.
        const decryptedAccName = await this.maskDecrypt(tx.bankAccount?.accountName);
        // ADM-205: kuorum dual approval untuk baris ini.
        const approverSet = approversByTx.get(tx.id) ?? new Set<string>();
        const approvalInfo: WithdrawalApprovalInfo = {
          approvals: approverSet.size,
          requiredApprovals: AdminFinanceService.requiredWithdrawalApprovals(
            toIdr(tx.amount),
            dualThresholdIdr,
          ),
          approvedByMe: approverSet.has(adminId),
        };
        return {
          ...tx,
          amount: toIdr(tx.amount),
          balanceBefore: toIdr(tx.balanceBefore),
          balanceAfter: toIdr(tx.balanceAfter),
          approvalInfo,
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
    // BAI-041 (P0) — JALUR PAYOUT MIDTRANS IRIS DI-SUNSET (2026-10-01).
    // DANA Enterprise adalah satu-satunya provider; antrean withdrawal legacy
    // (WalletTransaction) TIDAK LAGI dieksekusi via createIrisPayout.
    // Keputusan keamanan: 410 GONE eksplisit (bukan 403/404 yang ambigu atau
    // eksekusi diam-diam ke provider yang salah), plus WalletKillSwitchGuard
    // di controller sebagai pertahanan lapis kedua. Pencairan dana kini
    // tercatat di EscrowDisbursement — lihat GET /v1/admin/finance/disbursements.
    // Badan fungsi lama DIHAPUS (2026-10-01): kode setelah throw unconditional
    // tidak terjangkau dan merusak type-check (narrowing TS tidak berlaku di
    // kode unreachable). Arkeologi alur lama tersimpan di riwayat git.
    throw new GoneException({
      code: ErrorCodes.IRIS_PAYOUT_SUNSET,
      message:
        'Jalur payout Midtrans Iris sudah dinonaktifkan (410 GONE). ' +
        'Pencairan dana kini berjalan via disbursement DANA — lihat antrean "Disbursement DANA" ' +
        '(GET /v1/admin/finance/disbursements).',
    });
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
      action: AuditAction.WITHDRAWAL_REJECTED,
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

  /**
   * ADM-213 — pengecekan ulang manual SATU withdrawal PROCESSING ke provider.
   *
   * BUKAN retry payout: metode ini TIDAK PERNAH memanggil createIrisPayout.
   * Ia hanya menanyakan status payout ke Midtrans Iris lalu menerapkan
   * transisi aman yang sama dengan reconciler otomatis
   * (WithdrawalReconciliationService — jaga tetap sinkron):
   * - completed/processed → SUCCESS (uang terbukti keluar via provider)
   * - failed/rejected    → FAILED + refund ke wallet pengguna
   * - selain itu (queued/processing/not_found/unknown, atau provider tidak
   *   terjangkau) → tetap PROCESSING, TANPA mutasi uang (fail closed).
   */
  async recheckWithdrawal(txId: string, adminId: string, ipAddress: string): Promise<object> {
    // BAI-042 (P0) — RECHECK LEGACY DINONAKTIFKAN (2026-10-01).
    // Implementasi lama men-query Midtrans Iris (getIrisPayoutStatus) — provider
    // yang SALAH untuk payout era DANA (selalu not_found/UNKNOWN untuk referensi
    // DANA), sehingga satu-satunya tombol recheck menyesatkan operator.
    // Keputusan keamanan: 501 NOT_IMPLEMENTED eksplisit daripada query provider
    // yang salah. Untuk disbursement DANA gunakan
    // POST /v1/admin/finance/disbursements/:id/recheck (query status DANA yang
    // aman — tanpa pengiriman transfer baru).
    // Badan fungsi lama DIHAPUS (2026-10-01): kode setelah throw unconditional
    // tidak terjangkau dan merusak type-check (narrowing TS tidak berlaku di
    // kode unreachable). Arkeologi alur lama tersimpan di riwayat git.
    throw new NotImplementedException({
      code: ErrorCodes.LEGACY_WITHDRAWAL_RECHECK_DISABLED,
      message:
        'Recheck withdrawal legacy dinonaktifkan (501): jalur ini men-query Midtrans Iris, ' +
        'bukan DANA. Untuk payout DANA gunakan POST /v1/admin/finance/disbursements/:id/recheck.',
    });
  }

  /**
   * Kembaran WithdrawalReconciliationService.refundFailedWithdrawal — refund
   * untuk payout yang provider nyatakan gagal. Jaga tetap sinkron dengan
   * reconciler otomatis. Transaksi serializable + optimistic claim agar
   * refund tidak ganda bila cron dan admin recheck berjalan bersamaan.
   */
  private async refundProcessingWithdrawal(
    id: string,
    txId: string,
    walletId: string,
    amount: bigint,
    createdAt: Date,
  ): Promise<boolean> {
    return this.prisma.$transaction(
      async (ptx: Prisma.TransactionClient) => {
        const claimResult = await ptx.walletTransaction.updateMany({
          where: { id, withdrawStatus: 'PROCESSING' },
          data: {
            withdrawStatus: 'FAILED',
            status: 'FAILED',
            description: 'Payout failed — refunded via manual recheck',
          },
        });
        if (claimResult.count === 0) {
          this.logger.warn(`Withdrawal ${txId} already transitioned from PROCESSING, skipping manual refund`);
          return false;
        }
        const currentWallet = await ptx.wallet.findUnique({ where: { id: walletId } });
        if (!currentWallet) {
          throw new Error(`Wallet ${walletId} not found while refunding withdrawal ${txId}`);
        }
        const todayStart = startOfDayWIB();
        const isToday = createdAt >= todayStart;
        const withdrawRollback =
          isToday && currentWallet.todayWithdrawAmount >= amount
            ? { decrement: amount }
            : undefined;
        const walletUpdateResult = await ptx.wallet.updateMany({
          where: { id: walletId, version: currentWallet.version },
          data: {
            availableBalance: { increment: amount },
            totalBalance: { increment: amount },
            ...(withdrawRollback !== undefined ? { todayWithdrawAmount: withdrawRollback } : {}),
            version: { increment: 1 },
          },
        });
        if (walletUpdateResult.count === 0) {
          throw new Error(`OCC conflict refunding withdrawal ${txId} — will retry`);
        }
        return true;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  logReconciliation(adminId: string, userId: string, clean: boolean, ipAddress: string): void {
    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.WALLET_RECONCILED,
      targetType: 'Wallet',
      targetId: userId,
      description: `Admin reconciled wallet for user ${userId} — ${clean ? 'clean' : 'discrepancy found'}`,
      after: { clean },
      ipAddress,
    });
  }

  /**
   * BAI-047 (P1) + MFE-011: ringkasan escrow mencakup SEMUA "pot" dana.
   *
   * BAI-047: di era tanpa-wallet, dana escrow dipegang DANA (payment direct),
   * BUKAN kolom wallet.escrowBalance — sehingga SUM wallet selalu Rp0
   * sementara order aktif > 0 (kartu "Escrow aktif: Rp0" menyesatkan).
   * Bila wallet nonaktif: total = SUM(buyerPayAmount) order aktif
   * (PROCESSING/IN_DELIVERY/DISPUTED) + flag `source: 'ORDER_BASED'` agar UI
   * melabelinya dengan jelas. Bila wallet aktif: perilaku lama +
   * `source: 'WALLET_BASED'`.
   *
   * MFE-011: agregat DANA-direct (PaymentTransaction SUCCESS, purpose
   * ORDER_ESCROW, order masih aktif) selalu dihitung agar dashboard tidak
   * menampilkan escrow aktif Rp0 walau dana nyata tertahan di DANA.
   * Field dana* bersifat aditif (read-only; tanpa mutasi).
   */
  async getEscrowSummary(): Promise<{
    totalEscrowBalance: number;
    walletsWithEscrow: number;
    activeEscrowOrders: number;
    source: 'WALLET_BASED' | 'ORDER_BASED';
    /** MFE-011: agregat escrow DANA-direct (mode tanpa-wallet). */
    danaEscrowBalance: number;
    danaEscrowPayments: number;
    danaDisbursementsPending: number;
  }> {
    const activeOrderStatuses: OrderStatus[] = [
      OrderStatus.PROCESSING,
      OrderStatus.IN_DELIVERY,
      OrderStatus.DISPUTED,
    ];

    // MFE-011: agregat DANA-direct (read-only) — dihitung di kedua mode agar
    // admin selalu punya visibilitas pot escrow DANA.
    const [danaAgg, danaDisburs] = await Promise.all([
      this.prisma.paymentTransaction.aggregate({
        where: {
          provider: PaymentProvider.DANA,
          purpose: PaymentPurpose.ORDER_ESCROW,
          status: PaymentStatus.SUCCESS,
          order: { status: { in: activeOrderStatuses }, deletedAt: null },
        },
        _sum: { grossAmount: true },
        _count: true,
      }),
      this.prisma.escrowDisbursement.count({
        where: { status: { not: 'SUCCESS' } },
      }),
    ]);
    const danaFields = {
      danaEscrowBalance: toIdr(danaAgg._sum.grossAmount ?? BigInt(0)),
      danaEscrowPayments: danaAgg._count,
      danaDisbursementsPending: danaDisburs,
    };

    const activeEscrowOrders = await this.prisma.order.count({
      where: { status: { in: activeOrderStatuses } },
    });

    // BAI-047: mode tanpa-wallet → total dari order aktif (bukan kolom wallet).
    if (this.walletMode && !this.walletMode.isWalletEnabled()) {
      const orderAgg = await this.prisma.order.aggregate({
        where: { status: { in: activeOrderStatuses } },
        _sum: { buyerPayAmount: true },
      });
      return {
        // buyerPayAmount = total yang buyer bayar ke escrow DANA (orderValue +
        // buyerFee). Ini nilai escrow aktual yang ditahan di sisi DANA.
        totalEscrowBalance: toIdr(orderAgg._sum.buyerPayAmount ?? BigInt(0)),
        walletsWithEscrow: 0,
        activeEscrowOrders,
        source: 'ORDER_BASED',
        ...danaFields,
      };
    }

    const escrowAgg = await this.prisma.wallet.aggregate({
      where: { escrowBalance: { gt: 0 } },
      _sum: { escrowBalance: true },
      _count: true,
    });

    return {
      totalEscrowBalance: toIdr(escrowAgg._sum.escrowBalance ?? BigInt(0)),
      walletsWithEscrow: escrowAgg._count,
      activeEscrowOrders,
      source: 'WALLET_BASED',
      ...danaFields,
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
      // ADM-217: bucket bulan memakai batas WIB, bukan UTC. Semantik:
      // "completedAt" adalah timestamptz; `AT TIME ZONE 'Asia/Jakarta'`
      // mengubahnya ke wall-clock Jakarta, DATE_TRUNC memotong ke awal bulan
      // Jakarta, lalu `AT TIME ZONE 'Asia/Jakarta'` mengembalikannya menjadi
      // timestamptz (instan yang sama) agar tipe kolom & serialisasi JSON
      // tidak berubah. Tanpa ini, transaksi 1 Sep 00:30 WIB (= 31 Agu 17:30
      // UTC) salah masuk bucket Agustus.
      this.prisma.$queryRaw<Array<{ month: Date; total: bigint; count: bigint; source: string }>>`
        SELECT DATE_TRUNC('month', "completedAt" AT TIME ZONE 'Asia/Jakarta') AT TIME ZONE 'Asia/Jakarta' as month,
               COALESCE(SUM("feeAmount"), 0)::bigint as total,
               COUNT(*)::bigint as count,
               'fee'::text as source
        FROM orders
        WHERE status = 'COMPLETED'
          AND "completedAt" IS NOT NULL
        GROUP BY DATE_TRUNC('month', "completedAt" AT TIME ZONE 'Asia/Jakarta')
        UNION ALL
        SELECT DATE_TRUNC('month', "createdAt" AT TIME ZONE 'Asia/Jakarta') AT TIME ZONE 'Asia/Jakarta' as month,
               COALESCE(SUM(amount), 0)::bigint as total,
               COUNT(*)::bigint as count,
               'subscription'::text as source
        FROM wallet_transactions
        WHERE type = 'SUBSCRIPTION_PAYMENT'
          AND status = 'SUCCESS'
        GROUP BY DATE_TRUNC('month', "createdAt" AT TIME ZONE 'Asia/Jakarta')
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
