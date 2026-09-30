import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma, AuditAction, EscrowDisbursementStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { DanaDisbursementService } from '../../payment/dana/dana-disbursement.service';
import { decryptAES } from '../../../common/utils/crypto.util';
import { toIdr } from '../../../common/utils/currency.util';
import { createPaginatedResponse } from '../../../common/dto/pagination.dto';
import * as ErrorCodes from '../../../common/constants/error-codes';
import {
  DisbursementQueryDto,
  DisbursementReviewDto,
} from './dto/disbursement.dto';

export interface DisbursementListItem {
  id: string;
  idempotencyKey: string;
  scope: string;
  orderId: string | null;
  orderPublicId: string | null;
  sellerId: string;
  sellerName: string | null;
  amountSen: string;
  amountIdr: number;
  status: string;
  danaReferenceNo: string | null;
  danaPartnerReferenceNo: string | null;
  attemptCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface DisbursementDetail extends DisbursementListItem {
  scopeRefId: string | null;
  bankAccount: {
    id: string;
    bankCode: string;
    accountNameMasked: string | null;
    accountNumberMasked: string | null;
  } | null;
  heldReason: string | null;
  lastError: string | null;
  releasedAt: Date | null;
}

/**
 * BAI-043 (P0) — antrean admin READ-ONLY untuk lifecycle EscrowDisbursement
 * DANA (satu-satunya sumber kebenaran pencairan dana era tanpa-wallet:
 * escrow order, milestone, cashback, referral, dispute release, legacy payout).
 *
 * Prinsip keamanan uang:
 * - List & detail: murni baca. Tidak ada tombol eksekusi uang di fase ini.
 * - `recheckDisbursement`: hanya query status ke DANA (read terhadap
 *   provider), lalu menerapkan transisi yang SAMA dengan cron otomatis
 *   `reconcileProcessing` — TIDAK PERNAH mengirim transfer baru.
 * - `reviewDisbursement` (NEEDS_REVIEW → RETRY/CANCEL/FORCE_SUCCESS):
 *   SUPER_ADMIN only, reason min 10, audit trail wajib. Tidak memanggil
 *   DANA; RETRY didelegasikan ke cron retryDue yang idempoten via
 *   partnerReferenceNo stabil.
 * - `requeueDisbursement` (HELD_NO_BANK → PENDING): hanya mengubah status
 *   lokal agar cron retryDue memproses ulang setelah seller mendaftarkan
 *   rekening. Transfer aktual tetap lewat settle() yang fail-closed
 *   (inquiry bank + verifikasi nama).
 */
@Injectable()
export class AdminDisbursementService {
  private readonly logger = new Logger(AdminDisbursementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly danaDisbursement: DanaDisbursementService,
  ) {}

  async listDisbursements(query: DisbursementQueryDto): Promise<object> {
    const page = Number.isInteger(query.page) && (query.page as number) > 0 ? (query.page as number) : 1;
    const limit =
      Number.isInteger(query.limit) && (query.limit as number) > 0
        ? Math.min(query.limit as number, 100)
        : 20;

    const where: Prisma.EscrowDisbursementWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.scope) where.scope = query.scope;
    if (query.search) {
      const s = query.search.trim();
      where.OR = [
        { idempotencyKey: { contains: s, mode: 'insensitive' } },
        { danaReferenceNo: { contains: s, mode: 'insensitive' } },
        { danaPartnerReferenceNo: { contains: s, mode: 'insensitive' } },
        { sellerId: s },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.escrowDisbursement.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          seller: { select: { id: true, fullName: true, username: true } },
        },
      }),
      this.prisma.escrowDisbursement.count({ where }),
    ]);

    // EscrowDisbursement.orderId hanya scalar (tanpa relasi Prisma) —
    // ambil orderId publik (ORD-...) via batch query terpisah.
    const orderDbIds = [...new Set(rows.map((r) => r.orderId).filter((id): id is string => !!id))];
    const orderPublicById = new Map<string, string>();
    if (orderDbIds.length > 0) {
      const orders = await this.prisma.order.findMany({
        where: { id: { in: orderDbIds } },
        select: { id: true, orderId: true },
      });
      for (const o of orders) orderPublicById.set(o.id, o.orderId);
    }

    const data: DisbursementListItem[] = rows.map((r) =>
      this.toListItem(r, r.orderId ? (orderPublicById.get(r.orderId) ?? null) : null),
    );
    return createPaginatedResponse(data, total, page, limit);
  }

  async getDisbursement(id: string, adminId: string, ipAddress: string): Promise<DisbursementDetail> {
    const row = await this.prisma.escrowDisbursement.findUnique({
      where: { id },
      include: {
        seller: { select: { id: true, fullName: true, username: true } },
        bankAccount: { select: { id: true, bankCode: true, accountName: true, accountNumber: true } },
      },
    });
    if (!row) {
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Disbursement tidak ditemukan' });
    }

    // orderId publik (ORD-...) — relasi Prisma tidak ada, query terpisah.
    let orderPublicId: string | null = null;
    if (row.orderId) {
      const ord = await this.prisma.order.findUnique({
        where: { id: row.orderId },
        select: { orderId: true },
      });
      orderPublicId = ord?.orderId ?? null;
    }

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.DISBURSEMENT_VIEWED,
      targetType: 'EscrowDisbursement',
      targetId: row.id,
      description: `Admin ${adminId} melihat detail disbursement ${row.idempotencyKey} (${row.status})`,
      ipAddress,
    });

    return {
      ...this.toListItem(row, orderPublicId),
      scopeRefId: row.scopeRefId,
      bankAccount: row.bankAccount
        ? {
            id: row.bankAccount.id,
            bankCode: row.bankAccount.bankCode,
            accountNameMasked: await this.maskDecrypt(row.bankAccount.accountName),
            accountNumberMasked: await this.maskDecrypt(row.bankAccount.accountNumber),
          }
        : null,
      heldReason: row.heldReason,
      lastError: row.lastError,
      releasedAt: row.releasedAt,
    };
  }

  /**
   * BAI-042 (arahan DANA): cek ulang SATU disbursement PROCESSING ke DANA
   * Transfer-to-Bank Status API. Semantik identik dengan cron
   * `reconcileProcessing` — hanya baris dengan danaPartnerReferenceNo yang
   * diproses; hasil ambigu/exception → tetap PROCESSING (fail-closed).
   * TIDAK PERNAH mengirim transfer baru.
   */
  async recheckDisbursement(id: string, adminId: string, ipAddress: string): Promise<object> {
    const row = await this.prisma.escrowDisbursement.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Disbursement tidak ditemukan' });
    }
    if (row.status !== EscrowDisbursementStatus.PROCESSING) {
      throw new ConflictException({
        code: ErrorCodes.DISBURSEMENT_NOT_REQUEUABLE,
        message: `Hanya disbursement PROCESSING yang dapat di-recheck ke DANA (saat ini: ${row.status})`,
      });
    }
    if (!row.danaPartnerReferenceNo) {
      throw new BadRequestException({
        code: ErrorCodes.DISBURSEMENT_NOT_REQUEUABLE,
        message: 'Disbursement ini belum memiliki referensi DANA (belum pernah dikirim ke provider)',
      });
    }

    let outcome: 'CONFIRMED' | 'FAILED' | 'STILL_PROCESSING' | 'QUERY_FAILED' = 'STILL_PROCESSING';
    let providerStatus: string | null = null;
    try {
      const st = await this.danaDisbursement.transferToBankStatus(row.danaPartnerReferenceNo);
      providerStatus = st.status;
      if (st.status === 'SUCCESS') {
        await this.prisma.escrowDisbursement.update({
          where: { id: row.id },
          data: {
            status: EscrowDisbursementStatus.SUCCESS,
            danaReferenceNo: st.referenceNo || undefined,
            lastError: null,
            releasedAt: new Date(),
          },
        });
        outcome = 'CONFIRMED';
      } else if (st.status === 'FAILED' || st.status === 'EXPIRED') {
        await this.prisma.escrowDisbursement.update({
          where: { id: row.id },
          data: {
            status: EscrowDisbursementStatus.FAILED,
            lastError: `DANA status query (manual recheck): ${st.status}`.slice(0, 500),
          },
        });
        outcome = 'FAILED';
      }
      // PENDING / UNKNOWN → biarkan PROCESSING (fail-closed, seperti cron).
    } catch (e) {
      // Query gagal (network/timeout) — JANGAN ubah status; transfer mungkin
      // masih diproses DANA. Webhook/retry berikut yang menentukan.
      outcome = 'QUERY_FAILED';
      this.logger.warn(
        `Recheck manual disbursement gagal key=${row.idempotencyKey}: ${(e as Error).message}`,
      );
    }

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.DISBURSEMENT_RECHECKED,
      targetType: 'EscrowDisbursement',
      targetId: row.id,
      description:
        `Manual recheck disbursement ${row.idempotencyKey}: provider=${providerStatus ?? 'query-failed'} outcome=${outcome}`,
      after: { idempotencyKey: row.idempotencyKey, providerStatus, outcome },
      ipAddress,
    });

    const updated = await this.prisma.escrowDisbursement.findUniqueOrThrow({
      where: { id: row.id },
      select: { status: true },
    });
    return { id: row.id, idempotencyKey: row.idempotencyKey, providerStatus, outcome, status: updated.status };
  }

  /**
   * BAI-044 (P1): review manual baris NEEDS_REVIEW. SUPER_ADMIN only
   * (ditegakkan di controller via @AdminRoles). Audit trail wajib.
   */
  async reviewDisbursement(
    id: string,
    dto: DisbursementReviewDto,
    adminId: string,
    ipAddress: string,
  ): Promise<object> {
    const row = await this.prisma.escrowDisbursement.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Disbursement tidak ditemukan' });
    }
    if (row.status !== EscrowDisbursementStatus.NEEDS_REVIEW) {
      throw new ConflictException({
        code: ErrorCodes.DISBURSEMENT_NOT_REVIEWABLE,
        message: `Hanya disbursement NEEDS_REVIEW yang dapat di-review manual (saat ini: ${row.status})`,
      });
    }
    const reason = dto.reason.trim();
    if (reason.length < 10) {
      throw new BadRequestException({
        code: ErrorCodes.DISBURSEMENT_INVALID_DECISION,
        message: 'Alasan keputusan minimal 10 karakter',
      });
    }

    let nextStatus: EscrowDisbursementStatus;
    let note: string;
    switch (dto.decision) {
      case 'RETRY':
        // Kembalikan ke PENDING agar cron retryDue memproses ulang via
        // settle() — idempoten di sisi DANA via partnerReferenceNo stabil.
        nextStatus = EscrowDisbursementStatus.PENDING;
        note = `NEEDS_REVIEW di-retry manual → PENDING (cron retryDue akan memproses ulang secara idempoten)`;
        break;
      case 'CANCEL':
        nextStatus = EscrowDisbursementStatus.CANCELLED;
        note = 'NEEDS_REVIEW dibatalkan manual → CANCELLED (terminal)';
        break;
      case 'FORCE_SUCCESS':
        // PALING BERBAHAYA: menandai sukses tanpa konfirmasi provider.
        // Hanya sah bila admin sudah memverifikasi transfer di DANA dashboard
        // dan mencatat buktinya di reason. Fail-closed bila ragu.
        nextStatus = EscrowDisbursementStatus.SUCCESS;
        note = `NEEDS_REVIEW di-FORCE_SUCCESS manual — bukti: ${reason}`.slice(0, 500);
        break;
      default:
        throw new BadRequestException({
          code: ErrorCodes.DISBURSEMENT_INVALID_DECISION,
          message: 'Keputusan harus RETRY, CANCEL, atau FORCE_SUCCESS',
        });
    }

    const updated = await this.prisma.escrowDisbursement.update({
      where: { id: row.id },
      data: {
        status: nextStatus,
        lastError: note,
        ...(nextStatus === EscrowDisbursementStatus.SUCCESS ? { releasedAt: new Date() } : {}),
      },
    });

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.DISBURSEMENT_REVIEWED,
      targetType: 'EscrowDisbursement',
      targetId: row.id,
      description:
        `Review manual NEEDS_REVIEW ${row.idempotencyKey}: ${dto.decision} → ${nextStatus} oleh admin ${adminId}. Alasan: ${reason}`,
      after: {
        idempotencyKey: row.idempotencyKey,
        decision: dto.decision,
        from: 'NEEDS_REVIEW',
        to: nextStatus,
        reason,
      },
      ipAddress,
    });

    this.logger.log(
      `Disbursement ${row.idempotencyKey} reviewed: ${dto.decision} → ${nextStatus} oleh admin ${adminId}`,
    );
    return {
      id: updated.id,
      idempotencyKey: updated.idempotencyKey,
      status: updated.status,
      decision: dto.decision,
    };
  }

  /**
   * BAI-045 (P1): "cairkan ulang" untuk baris HELD_NO_BANK — setelah seller
   * mendaftarkan rekening terverifikasi, kembalikan ke PENDING agar cron
   * retryDue memprosesnya via settle() (inquiry bank + verifikasi nama
   * tetap dijalankan — fail-closed bila rekening belum valid).
   */
  async requeueDisbursement(id: string, adminId: string, ipAddress: string): Promise<object> {
    const row = await this.prisma.escrowDisbursement.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Disbursement tidak ditemukan' });
    }
    if (row.status !== EscrowDisbursementStatus.HELD_NO_BANK) {
      throw new ConflictException({
        code: ErrorCodes.DISBURSEMENT_NOT_REQUEUABLE,
        message: `Hanya disbursement HELD_NO_BANK yang dapat dicairkan ulang (saat ini: ${row.status})`,
      });
    }

    const updated = await this.prisma.escrowDisbursement.update({
      where: { id: row.id },
      data: {
        status: EscrowDisbursementStatus.PENDING,
        heldReason: null,
        lastError: null,
      },
    });

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.DISBURSEMENT_REQUEUED,
      targetType: 'EscrowDisbursement',
      targetId: row.id,
      description:
        `Disbursement ${row.idempotencyKey} HELD_NO_BANK → PENDING (cairkan ulang manual oleh admin ${adminId}); cron retryDue akan memproses setelah rekening seller terverifikasi`,
      after: {
        idempotencyKey: row.idempotencyKey,
        from: 'HELD_NO_BANK',
        to: 'PENDING',
      },
      ipAddress,
    });

    return { id: updated.id, idempotencyKey: updated.idempotencyKey, status: updated.status };
  }

  private toListItem(
    r: {
      id: string;
      idempotencyKey: string;
      scope: string;
      orderId: string | null;
      sellerId: string;
      amountSen: bigint;
      status: string;
      danaReferenceNo: string | null;
      danaPartnerReferenceNo: string | null;
      attemptCount: number;
      createdAt: Date;
      updatedAt: Date;
      seller?: { id: string; fullName: string; username: string | null } | null;
    },
    orderPublicId: string | null,
  ): DisbursementListItem {
    return {
      id: r.id,
      idempotencyKey: r.idempotencyKey,
      scope: r.scope,
      orderId: r.orderId,
      orderPublicId,
      sellerId: r.sellerId,
      sellerName: r.seller?.fullName ?? r.seller?.username ?? null,
      amountSen: r.amountSen.toString(),
      amountIdr: toIdr(r.amountSen),
      status: r.status,
      danaReferenceNo: r.danaReferenceNo,
      danaPartnerReferenceNo: r.danaPartnerReferenceNo,
      attemptCount: r.attemptCount,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  /** Decrypt lalu mask — gagal decrypt → null (fail-closed, bukan bocor). */
  private async maskDecrypt(cipher: string | null): Promise<string | null> {
    if (!cipher) return null;
    try {
      const plain = await decryptAES(cipher);
      return plain.length <= 4 ? '****' : `****${plain.slice(-4)}`;
    } catch {
      return null;
    }
  }
}
