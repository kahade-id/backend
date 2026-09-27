import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';

/**
 * ID permintaan koreksi. Format `CORR-<uuid>` — lolos ParseIdPipe
 * (PREFIXED_ID_RE) sehingga endpoint :id tidak melempar 400 untuk ID valid.
 */
export function newCorrectionId(): string {
  return `CORR-${randomUUID()}`;
}
import { PrismaService } from '../../../prisma/prisma.service';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import {
  AuditAction,
  NotificationType,
  Prisma,
  WalletTransactionStatus,
  WalletTransactionType,
} from '@prisma/client';
import { toSen } from '../../../common/utils/currency.util';
import { generateWalletTxId, generateNotifId } from '../../../common/utils/id-generator.util';
import { getCategoryForType } from '../../notifications/notification-category.map';
import { createPaginatedResponse } from '../../../common/dto/pagination.dto';
import {
  RequestCorrectionDto,
  DecideCorrectionDto,
  CorrectionsQueryDto,
  CorrectionType,
} from './dto/ledger-correction.dto';

/**
 * E3 (G326-G350) — koreksi ledger manual dengan approval dua admin.
 *
 * Alur:
 *  1. `POST /corrections` (admin A) → request PENDING_APPROVAL. TIDAK ada
 *     mutasi saldo pada tahap ini.
 *  2. `POST /corrections/:id/approve` (admin B ≠ A) → eksekusi mutasi atomik
 *     (advisory lock per-request + transaksi serializable + optimistic lock
 *     versi wallet), atau REJECT.
 *
 * Penyimpanan (tanpa migrasi baru, sesuai arahan koordinator): request &
 * decision dicatat sebagai baris append-only di `admin_audit_logs` dengan
 * action MANUAL_LEDGER_CORRECTION dan targetType terstruktur:
 *   - 'LedgerCorrectionRequest'  → payload JSON status PENDING_APPROVAL
 *   - 'LedgerCorrectionDecision' → payload JSON APPROVED/REJECTED
 * FOLLOW-UP: pindahkan ke model LedgerCorrection dedicated pada migrasi
 * milik koordinator bila tersedia (kolom status/type terindeks, dsb.).
 *
 * Keamanan:
 * - Self-approve ditolak (403).
 * - Rate limit nominal: amountIdr > MAX_LEDGER_CORRECTION_IDR ditolak.
 * - Idempotency domain via `idempotencyKey`: replay payload sama →
 *   kembalikan request yang sama; payload beda → 409.
 * - Alasan + ticketRef WAJIB (validasi DTO).
 * - `reauthToken` diterima tetapi verifikasi server-side BELUM tersedia
 *   (tidak ada mekanisme re-auth admin yang ada) — dicatat sebagai
 *   follow-up; UI wajib meminta kata sandi admin sebelum submit.
 */
export const MAX_LEDGER_CORRECTION_IDR = 10_000_000;

const TARGET_REQUEST = 'LedgerCorrectionRequest';
const TARGET_DECISION = 'LedgerCorrectionDecision';

export type CorrectionStatus = 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';

export interface CorrectionView {
  id: string;
  userId: string;
  amountIdr: number;
  type: CorrectionType;
  reason: string;
  ticketRef: string;
  idempotencyKey: string;
  status: CorrectionStatus;
  requestedBy: string;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNotes: string | null;
  executedTxId: string | null;
}

interface RequestPayload {
  userId: string;
  amountSen: string;
  amountIdr: number;
  type: CorrectionType;
  reason: string;
  ticketRef: string;
  idempotencyKey: string;
  requestedBy: string;
  requestedAt: string;
  status: 'PENDING_APPROVAL';
}

interface DecisionPayload {
  status: 'APPROVED' | 'REJECTED';
  decidedBy: string;
  decidedAt: string;
  notes: string | null;
  executedTxId: string | null;
}

@Injectable()
export class LedgerCorrectionService {
  private readonly logger = new Logger(LedgerCorrectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletTxSerial: WalletTxSerialService,
  ) {}

  /** Guard murni (unit-testable): approver tidak boleh sama dengan requester. */
  static assertNotSelfApproval(requestedBy: string, approverId: string): void {
    if (requestedBy === approverId) {
      throw new ForbiddenException({
        code: 'CORRECTION_SELF_APPROVAL',
        message: 'Koreksi harus disetujui admin yang berbeda (dual approval)',
      });
    }
  }

  /** Guard murni (unit-testable): rate limit nominal per koreksi. */
  static assertAmountWithinLimit(amountIdr: number): void {
    if (!Number.isFinite(amountIdr) || amountIdr <= 0) {
      throw new BadRequestException({
        code: 'CORRECTION_INVALID_AMOUNT',
        message: 'Nominal koreksi harus lebih dari 0',
      });
    }
    if (amountIdr > MAX_LEDGER_CORRECTION_IDR) {
      throw new UnprocessableEntityException({
        code: 'CORRECTION_AMOUNT_EXCEEDS_LIMIT',
        message: `Nominal koreksi maksimal Rp${MAX_LEDGER_CORRECTION_IDR.toLocaleString('id-ID')} per koreksi`,
      });
    }
  }

  private requestWhere(idempotencyKey: string): Prisma.AdminAuditLogWhereInput {
    return {
      action: AuditAction.MANUAL_LEDGER_CORRECTION,
      targetType: TARGET_REQUEST,
      after: { path: ['idempotencyKey'], equals: idempotencyKey },
    };
  }

  private async findRequestRow(requestId: string) {
    const row = await this.prisma.adminAuditLog.findFirst({
      where: {
        action: AuditAction.MANUAL_LEDGER_CORRECTION,
        targetType: TARGET_REQUEST,
        targetId: requestId,
      },
    });
    if (!row) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Correction request not found' });
    }
    return row;
  }

  private async findDecisionRow(requestId: string) {
    return this.prisma.adminAuditLog.findFirst({
      where: {
        action: AuditAction.MANUAL_LEDGER_CORRECTION,
        targetType: TARGET_DECISION,
        targetId: requestId,
      },
    });
  }

  private toView(requestRow: { id: string; targetId: string | null; after: unknown }, decisionRow?: { after: unknown } | null): CorrectionView {
    const req = requestRow.after as unknown as RequestPayload;
    const dec = (decisionRow?.after as unknown as DecisionPayload | undefined) ?? null;
    return {
      id: requestRow.targetId ?? requestRow.id,
      userId: req.userId,
      amountIdr: req.amountIdr,
      type: req.type,
      reason: req.reason,
      ticketRef: req.ticketRef,
      idempotencyKey: req.idempotencyKey,
      status: dec ? dec.status : 'PENDING_APPROVAL',
      requestedBy: req.requestedBy,
      requestedAt: req.requestedAt,
      decidedBy: dec?.decidedBy ?? null,
      decidedAt: dec?.decidedAt ?? null,
      decisionNotes: dec?.notes ?? null,
      executedTxId: dec?.executedTxId ?? null,
    };
  }

  async requestCorrection(adminId: string, dto: RequestCorrectionDto, ipAddress: string): Promise<CorrectionView> {
    LedgerCorrectionService.assertAmountWithinLimit(dto.amountIdr);

    // Idempotency domain: replay dengan kunci sama.
    const existing = await this.prisma.adminAuditLog.findFirst({ where: this.requestWhere(dto.idempotencyKey) });
    if (existing) {
      const prev = existing.after as unknown as RequestPayload;
      const samePayload =
        prev.userId === dto.userId &&
        prev.amountIdr === dto.amountIdr &&
        prev.type === dto.type &&
        prev.reason === dto.reason &&
        prev.ticketRef === dto.ticketRef;
      if (!samePayload) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_REUSE',
          message: 'idempotencyKey sudah dipakai untuk koreksi yang berbeda',
        });
      }
      const decision = await this.findDecisionRow(existing.targetId ?? existing.id);
      return this.toView(existing, decision);
    }

    const wallet = await this.prisma.wallet.findUnique({
      where: { userId: dto.userId },
      select: { id: true, availableBalance: true, isLocked: true },
    });
    if (!wallet) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Wallet not found for user' });
    }
    if (wallet.isLocked) {
      throw new BadRequestException({ code: 'WALLET_LOCKED', message: 'Wallet terkunci — buka kunci sebelum koreksi' });
    }
    const amountSen = toSen(dto.amountIdr);
    if (dto.type === 'DEBIT' && wallet.availableBalance < amountSen) {
      throw new UnprocessableEntityException({
        code: 'INSUFFICIENT_BALANCE',
        message: 'Saldo available tidak cukup untuk koreksi debit',
      });
    }

    if (dto.reauthToken) {
      // FOLLOW-UP: tidak ada mekanisme verifikasi re-auth admin; token dicatat
      // penerimaannya saja. Jangan log nilainya.
      this.logger.warn('reauthToken supplied for correction request but server-side verification is not implemented (follow-up)');
    }

    const requestId = newCorrectionId();
    const payload: RequestPayload = {
      userId: dto.userId,
      amountSen: amountSen.toString(),
      amountIdr: dto.amountIdr,
      type: dto.type,
      reason: dto.reason.trim(),
      ticketRef: dto.ticketRef.trim(),
      idempotencyKey: dto.idempotencyKey,
      requestedBy: adminId,
      requestedAt: new Date().toISOString(),
      status: 'PENDING_APPROVAL',
    };

    // Tulis sinkron via Prisma (bukan queue audit) agar idempotency & status
    // langsung konsisten untuk pemanggil berikutnya.
    const row = await this.prisma.adminAuditLog.create({
      data: {
        adminId,
        action: AuditAction.MANUAL_LEDGER_CORRECTION,
        targetType: TARGET_REQUEST,
        targetId: requestId,
        description: `Ledger correction requested (${dto.type} Rp${dto.amountIdr.toLocaleString('id-ID')}) for user ${dto.userId} — ticket ${dto.ticketRef}. Menunggu approval admin kedua.`,
        after: payload as unknown as Prisma.InputJsonValue,
        ipAddress,
      },
    });

    return this.toView(row, null);
  }

  async decideCorrection(
    requestId: string,
    approverId: string,
    dto: DecideCorrectionDto,
    ipAddress: string,
  ): Promise<CorrectionView> {
    const requestRow = await this.findRequestRow(requestId);
    const req = requestRow.after as unknown as RequestPayload;

    LedgerCorrectionService.assertNotSelfApproval(req.requestedBy, approverId);

    const existingDecision = await this.findDecisionRow(requestId);
    if (existingDecision) {
      throw new ConflictException({
        code: 'CORRECTION_ALREADY_DECIDED',
        message: 'Koreksi ini sudah diputuskan',
      });
    }

    if (dto.reauthToken) {
      this.logger.warn('reauthToken supplied for correction decision but server-side verification is not implemented (follow-up)');
    }

    if (dto.decision === 'REJECT') {
      const decisionRow = await this.prisma.adminAuditLog.create({
        data: {
          adminId: approverId,
          action: AuditAction.MANUAL_LEDGER_CORRECTION,
          targetType: TARGET_DECISION,
          targetId: requestId,
          description: `Ledger correction ${requestId} REJECTED by admin ${approverId}${dto.notes ? `: ${dto.notes.slice(0, 200)}` : ''}`,
          after: {
            status: 'REJECTED',
            decidedBy: approverId,
            decidedAt: new Date().toISOString(),
            notes: dto.notes?.trim() || null,
            executedTxId: null,
          } as unknown as Prisma.InputJsonValue,
          ipAddress,
        },
      });
      return this.toView(requestRow, decisionRow);
    }

    // APPROVE → eksekusi mutasi atomik.
    LedgerCorrectionService.assertAmountWithinLimit(req.amountIdr);
    const amountSen = BigInt(req.amountSen);
    const isCredit = req.type === 'CREDIT';
    const txType = isCredit ? WalletTransactionType.ADMIN_CREDIT : WalletTransactionType.ADMIN_DEBIT;

    // Serial dibuat sebelum transaksi (pola adjustWallet): rollback tidak
    // membuat gap serial yang terbuang sia-sia di Redis.
    const serial = await this.walletTxSerial.getNext();
    const txId = generateWalletTxId(serial);

    const result = await this.prisma.$transaction(async (tx) => {
      // Kunci advisory per-request: dua admin yang menekan "setujui" bersamaan
      // untuk request yang sama akan serial di sini; yang kedua melihat
      // decision row dan melempar CORRECTION_ALREADY_DECIDED.
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, `ledger_correction:${requestId}`);

      const raced = await tx.adminAuditLog.findFirst({
        where: {
          action: AuditAction.MANUAL_LEDGER_CORRECTION,
          targetType: TARGET_DECISION,
          targetId: requestId,
        },
        select: { id: true },
      });
      if (raced) {
        throw new ConflictException({
          code: 'CORRECTION_ALREADY_DECIDED',
          message: 'Koreksi ini sudah diputuskan (concurrent approval)',
        });
      }

      const wallet = await tx.wallet.findUnique({ where: { userId: req.userId } });
      if (!wallet) {
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Wallet not found for user' });
      }
      if (wallet.isLocked) {
        throw new BadRequestException({ code: 'WALLET_LOCKED', message: 'Wallet terkunci' });
      }
      if (!isCredit && wallet.availableBalance < amountSen) {
        throw new UnprocessableEntityException({
          code: 'INSUFFICIENT_BALANCE',
          message: 'Saldo available tidak cukup untuk koreksi debit',
        });
      }

      const balanceBefore = wallet.availableBalance;
      const balanceAfter = isCredit ? wallet.availableBalance + amountSen : wallet.availableBalance - amountSen;

      const updated = await tx.wallet.updateMany({
        where: { id: wallet.id, version: wallet.version },
        data: {
          availableBalance: balanceAfter,
          totalBalance: isCredit ? wallet.totalBalance + amountSen : wallet.totalBalance - amountSen,
          version: { increment: 1 },
        },
      });
      if (updated.count === 0) {
        throw new ConflictException({
          code: 'OPTIMISTIC_LOCK_CONFLICT',
          message: 'Wallet berubah bersamaan — silakan coba lagi',
        });
      }

      await tx.walletTransaction.create({
        data: {
          txId,
          walletId: wallet.id,
          type: txType,
          status: WalletTransactionStatus.SUCCESS,
          amount: amountSen,
          balanceBefore,
          balanceAfter,
          description:
            `Koreksi ledger manual (${req.type}) oleh admin ${req.requestedBy}, disetujui ${approverId} — ` +
            `ticket ${req.ticketRef}: ${req.reason}`.slice(0, 500),
          completedAt: new Date(),
        },
      });

      const notifType = isCredit ? NotificationType.WALLET_TOPUP_SUCCESS : NotificationType.WALLET_WITHDRAW_SUCCESS;
      await tx.notification.create({
        data: {
          notifId: generateNotifId(),
          userId: req.userId,
          type: notifType,
          category: getCategoryForType(notifType),
          title: isCredit ? 'Koreksi Saldo oleh Admin' : 'Koreksi Saldo oleh Admin',
          body: isCredit
            ? `Saldo Anda dikoreksi +Rp${req.amountIdr.toLocaleString('id-ID')} oleh tim keuangan Kahade (tiket ${req.ticketRef}).`
            : `Saldo Anda dikoreksi -Rp${req.amountIdr.toLocaleString('id-ID')} oleh tim keuangan Kahade (tiket ${req.ticketRef}).`,
          isRead: false,
        },
      });

      const decisionRow = await tx.adminAuditLog.create({
        data: {
          adminId: approverId,
          action: AuditAction.MANUAL_LEDGER_CORRECTION,
          targetType: TARGET_DECISION,
          targetId: requestId,
          description:
            `Ledger correction ${requestId} APPROVED by admin ${approverId} ` +
            `(requested by ${req.requestedBy}): ${req.type} Rp${req.amountIdr.toLocaleString('id-ID')} → tx ${txId}`,
          after: {
            status: 'APPROVED',
            decidedBy: approverId,
            decidedAt: new Date().toISOString(),
            notes: dto.notes?.trim() || null,
            executedTxId: txId,
          } as unknown as Prisma.InputJsonValue,
          ipAddress,
        },
      });
      return { decisionRow, balanceAfter };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    this.logger.log(
      `Ledger correction ${requestId} executed: ${req.type} Rp${req.amountIdr.toLocaleString('id-ID')} ` +
      `for user ${req.userId} (tx ${txId}), requested by ${req.requestedBy}, approved by ${approverId}`,
    );

    return {
      ...this.toView(requestRow, result.decisionRow),
      executedTxId: txId,
    };
  }

  async getCorrection(requestId: string): Promise<CorrectionView> {
    const requestRow = await this.findRequestRow(requestId);
    const decision = await this.findDecisionRow(requestId);
    return this.toView(requestRow, decision);
  }

  async listCorrections(query: CorrectionsQueryDto): Promise<object> {
    const { page = 1, limit = 20, status } = query;
    const safePage = Number.isInteger(page) && page > 0 ? page : 1;
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;

    const where: Prisma.AdminAuditLogWhereInput = {
      action: AuditAction.MANUAL_LEDGER_CORRECTION,
      targetType: TARGET_REQUEST,
    };
    // Volume koreksi admin rendah; bila filter status dipakai, ambil hingga
    // 500 baris terbaru lalu filter di memori agar paginasi tetap benar
    // (status tersimpan di JSON `after`, bukan kolom terindeks).
    const fetchLimit = status ? 500 : safeLimit;
    const fetchSkip = status ? 0 : (safePage - 1) * safeLimit;
    const [rows, total] = await Promise.all([
      this.prisma.adminAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: fetchSkip,
        take: fetchLimit,
      }),
      this.prisma.adminAuditLog.count({ where }),
    ]);

    const requestIds = rows.map((r) => r.targetId ?? r.id);
    const decisions = requestIds.length
      ? await this.prisma.adminAuditLog.findMany({
          where: {
            action: AuditAction.MANUAL_LEDGER_CORRECTION,
            targetType: TARGET_DECISION,
            targetId: { in: requestIds },
          },
        })
      : [];
    const decisionByRequest = new Map(decisions.map((d) => [d.targetId as string, d]));

    const views = rows.map((r) => this.toView(r, decisionByRequest.get(r.targetId ?? r.id) ?? null));
    const filtered = status ? views.filter((v) => v.status === status) : views;
    const paged = status
      ? filtered.slice((safePage - 1) * safeLimit, safePage * safeLimit)
      : filtered;

    return createPaginatedResponse(paged, filtered.length, safePage, safeLimit);
  }
}
