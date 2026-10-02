import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AdminRole, AuditAction, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import * as ErrorCodes from '../../../common/constants/error-codes';
import {
  APPROVAL_ACTION_ROLES,
  APPROVAL_ACTION_TYPES,
  ApprovalActionType,
} from './dto/approval.dto';
import { APPROVAL_TTL_MS } from './dual-control.constants';

/** Konteks yang diteruskan ke executor saat approval di-approve. */
export interface ApprovalExecutionContext {
  approvalId: string;
  actionType: ApprovalActionType;
  targetId: string | null;
  payload: Record<string, unknown>;
  amountSen: bigint | null;
  proposedBy: string;
  /** Admin KEDUA yang menyetujui (dijamin != proposedBy oleh guard SELF_APPROVAL). */
  decidedBy: string;
  ipAddress: string;
}

export type ApprovalExecutor = (
  ctx: ApprovalExecutionContext,
) => Promise<unknown>;

export interface ProposeApprovalInput {
  actionType: ApprovalActionType;
  targetId?: string;
  payload: Record<string, unknown>;
  amountSen?: number;
  idempotencyKey: string;
  proposedBy: string;
  proposerRole: AdminRole;
  ipAddress: string;
}

export interface ApprovalView {
  approvalId: string;
  actionType: ApprovalActionType;
  targetId: string | null;
  status: string;
  proposedBy: string;
  proposedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  executedAt: string | null;
  expiresAt: string;
  amountSen: string | null;
}

/**
 * SEC-501/502/601/602 + BAD-001 (audit 2026-10-03): dual control
 * (maker-checker) untuk aksi admin sensitif.
 *
 * Alur: propose (pengusul + step-up) → PENDING → approve (admin KEDUA,
 * != pengusul, + step-up miliknya) → executor → EXECUTED.
 *
 * Executor didaftarkan oleh modul domain via registerExecutor() (dipanggil
 * di onModuleInit/constructor service domain) — modul ini TIDAK mengimpor
 * service domain agar tidak ada dependency cycle.
 */
@Injectable()
export class ApprovalsService {
  private readonly logger = new Logger(ApprovalsService.name);
  private readonly executors = new Map<ApprovalActionType, ApprovalExecutor>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  /** Didaftarkan modul domain (sekali per tipe aksi). */
  registerExecutor(actionType: ApprovalActionType, executor: ApprovalExecutor): void {
    if (this.executors.has(actionType)) {
      this.logger.warn(`Executor untuk ${actionType} didaftarkan ulang — menimpa.`);
    }
    this.executors.set(actionType, executor);
  }

  // ── Propose ──────────────────────────────────────────────

  async propose(input: ProposeApprovalInput): Promise<ApprovalView> {
    const { actionType } = input;
    if (!(APPROVAL_ACTION_TYPES as readonly string[]).includes(actionType)) {
      throw new BadRequestException({
        code: ErrorCodes.APPROVAL_FORBIDDEN_ACTION,
        message: `Tipe aksi tidak didukung: ${actionType}`,
      });
    }
    const allowedRoles = APPROVAL_ACTION_ROLES[actionType];
    if (!allowedRoles.includes(input.proposerRole)) {
      throw new ForbiddenException({
        code: ErrorCodes.APPROVAL_FORBIDDEN_ACTION,
        message: `Role ${input.proposerRole} tidak boleh mengusulkan aksi ${actionType}`,
      });
    }
    this.validatePayload(actionType, input.targetId, input.payload);

    // Idempoten per idempotencyKey: propose ulang mengembalikan record yang ada.
    const existing = await this.prisma.adminActionApproval.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      this.auditLog.logAdminAction({
        adminId: input.proposedBy,
        action: AuditAction.ADMIN_ACTION,
        targetType: 'AdminActionApproval',
        targetId: existing.id,
        description:
          `Propose ${actionType} idempoten — mengembalikan approval ${existing.id} yang sudah ada (status ${existing.status})`,
        ipAddress: input.ipAddress,
      });
      return this.toView(existing);
    }

    const now = new Date();
    const record = await this.prisma.adminActionApproval.create({
      data: {
        actionType,
        targetId: input.targetId ?? null,
        payload: input.payload as unknown as Prisma.InputJsonValue,
        amountSen:
          input.amountSen !== undefined ? BigInt(Math.trunc(input.amountSen)) : null,
        idempotencyKey: input.idempotencyKey,
        proposedBy: input.proposedBy,
        proposedAt: now,
        status: 'PENDING',
        expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
      },
    });

    this.auditLog.logAdminAction({
      adminId: input.proposedBy,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'AdminActionApproval',
      targetId: record.id,
      description:
        `Mengusulkan ${actionType}${input.targetId ? ` untuk target ${input.targetId}` : ''} ` +
        `(butuh persetujuan admin kedua; kedaluwarsa ${record.expiresAt.toISOString()})`,
      ipAddress: input.ipAddress,
    });

    return this.toView(record);
  }

  // ── Approve ──────────────────────────────────────────────

  async approve(
    approvalId: string,
    decidedBy: string,
    deciderRole: AdminRole,
    ipAddress: string,
  ): Promise<ApprovalView & { result?: unknown }> {
    const approval = await this.prisma.adminActionApproval.findUnique({
      where: { id: approvalId },
    });
    if (!approval) {
      throw new NotFoundException({
        code: ErrorCodes.APPROVAL_NOT_FOUND,
        message: 'Approval tidak ditemukan',
      });
    }
    const actionType = approval.actionType as ApprovalActionType;
    this.assertPending(approval);

    // SEC-501/502: maker != checker — pengusul TIDAK BOLEH menyetujui sendiri.
    if (approval.proposedBy === decidedBy) {
      throw new ForbiddenException({
        code: ErrorCodes.SELF_APPROVAL,
        message: 'Pengusul tidak boleh menyetujui usulannya sendiri (dual control)',
      });
    }
    if (!APPROVAL_ACTION_ROLES[actionType].includes(deciderRole)) {
      throw new ForbiddenException({
        code: ErrorCodes.APPROVAL_FORBIDDEN_ACTION,
        message: `Role ${deciderRole} tidak boleh menyetujui aksi ${actionType}`,
      });
    }
    const executor = this.executors.get(actionType);
    if (!executor) {
      // Fail-closed: tidak ada executor terdaftar → jangan eksekusi diam-diam.
      throw new ConflictException({
        code: ErrorCodes.APPROVAL_INVALID_STATE,
        message: `Tidak ada executor terdaftar untuk ${actionType} — approval tidak bisa dieksekusi`,
      });
    }

    // Klaim atomik: hanya SATU approver yang menang bila ada race.
    const claimed = await this.prisma.adminActionApproval.updateMany({
      where: { id: approvalId, status: 'PENDING' },
      data: { status: 'APPROVED', decidedBy, decidedAt: new Date() },
    });
    if (claimed.count === 0) {
      throw new ConflictException({
        code: ErrorCodes.APPROVAL_INVALID_STATE,
        message: 'Approval sudah diputuskan/diambil approver lain',
      });
    }

    let result: unknown;
    try {
      result = await executor({
        approvalId,
        actionType,
        targetId: approval.targetId,
        payload: (approval.payload ?? {}) as Record<string, unknown>,
        amountSen: approval.amountSen,
        proposedBy: approval.proposedBy,
        decidedBy,
        ipAddress,
      });
    } catch (err) {
      // Eksekusi gagal → kembalikan ke PENDING agar bisa di-retry setelah
      // diperbaiki (keputusan checker dibatalkan, bukan setengah jalan).
      await this.prisma.adminActionApproval.update({
        where: { id: approvalId },
        data: { status: 'PENDING', decidedBy: null, decidedAt: null },
      });
      this.auditLog.logAdminAction({
        adminId: decidedBy,
        action: AuditAction.ADMIN_ACTION,
        targetType: 'AdminActionApproval',
        targetId: approvalId,
        description:
          `Approve ${actionType} GAGAL dieksekusi — dikembalikan ke PENDING: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        ipAddress,
      });
      throw err;
    }

    const executed = await this.prisma.adminActionApproval.update({
      where: { id: approvalId },
      data: { status: 'EXECUTED', executedAt: new Date() },
    });

    this.auditLog.logAdminAction({
      adminId: decidedBy,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'AdminActionApproval',
      targetId: approvalId,
      description:
        `Menyetujui + mengeksekusi ${actionType}${approval.targetId ? ` (${approval.targetId})` : ''} ` +
        `yang diusulkan ${approval.proposedBy}`,
      ipAddress,
    });

    return { ...this.toView(executed), result };
  }

  // ── Reject ───────────────────────────────────────────────

  async reject(
    approvalId: string,
    decidedBy: string,
    deciderRole: AdminRole,
    reason: string | undefined,
    ipAddress: string,
  ): Promise<ApprovalView> {
    const approval = await this.prisma.adminActionApproval.findUnique({
      where: { id: approvalId },
    });
    if (!approval) {
      throw new NotFoundException({
        code: ErrorCodes.APPROVAL_NOT_FOUND,
        message: 'Approval tidak ditemukan',
      });
    }
    const actionType = approval.actionType as ApprovalActionType;
    this.assertPending(approval);
    // Pengusul boleh membatalkan usulannya sendiri; selain itu harus role yang
    // berhak atas tipe aksi ini.
    if (
      approval.proposedBy !== decidedBy &&
      !APPROVAL_ACTION_ROLES[actionType].includes(deciderRole)
    ) {
      throw new ForbiddenException({
        code: ErrorCodes.APPROVAL_FORBIDDEN_ACTION,
        message: `Role ${deciderRole} tidak boleh menolak aksi ${actionType}`,
      });
    }

    const rejected = await this.prisma.adminActionApproval.updateMany({
      where: { id: approvalId, status: 'PENDING' },
      data: {
        status: 'REJECTED',
        decidedBy,
        decidedAt: new Date(),
        rejectReason: reason?.trim() || null,
      },
    });
    if (rejected.count === 0) {
      throw new ConflictException({
        code: ErrorCodes.APPROVAL_INVALID_STATE,
        message: 'Approval sudah diputuskan/diambil pihak lain',
      });
    }

    this.auditLog.logAdminAction({
      adminId: decidedBy,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'AdminActionApproval',
      targetId: approvalId,
      description:
        `Menolak usulan ${actionType}${approval.targetId ? ` (${approval.targetId})` : ''}` +
        (reason?.trim() ? `: ${reason.trim()}` : ''),
      ipAddress,
    });

    const fresh = await this.prisma.adminActionApproval.findUnique({ where: { id: approvalId } });
    return this.toView(fresh!);
  }

  // ── Pending list ─────────────────────────────────────────

  /** Ambil satu approval (404 bila tidak ada) — dipakai controller approve. */
  async getByIdOrThrow(approvalId: string): Promise<ApprovalView> {
    const approval = await this.prisma.adminActionApproval.findUnique({
      where: { id: approvalId },
    });
    if (!approval) {
      throw new NotFoundException({
        code: ErrorCodes.APPROVAL_NOT_FOUND,
        message: 'Approval tidak ditemukan',
      });
    }
    return this.toView(approval);
  }

  async listPending(): Promise<ApprovalView[]> {
    // Tandai yang kedaluwarsa secara lazy.
    await this.prisma.adminActionApproval.updateMany({
      where: { status: 'PENDING', expiresAt: { lte: new Date() } },
      data: { status: 'EXPIRED' },
    });
    const rows = await this.prisma.adminActionApproval.findMany({
      where: { status: 'PENDING' },
      orderBy: { proposedAt: 'asc' },
    });
    return rows.map((r) => this.toView(r));
  }

  // ── Helpers ──────────────────────────────────────────────

  private assertPending(approval: { status: string; expiresAt: Date; id: string }): void {
    if (approval.expiresAt <= new Date()) {
      // Tandai agar tidak selamanya PENDING.
      void this.prisma.adminActionApproval
        .updateMany({ where: { id: approval.id, status: 'PENDING' }, data: { status: 'EXPIRED' } })
        .catch(() => undefined);
      throw new ForbiddenException({
        code: ErrorCodes.APPROVAL_EXPIRED,
        message: 'Approval sudah kedaluwarsa (24 jam) — buat usulan baru',
      });
    }
    if (approval.status !== 'PENDING') {
      throw new ConflictException({
        code: ErrorCodes.APPROVAL_INVALID_STATE,
        message: `Approval sudah berstatus ${approval.status} — tidak bisa diputuskan lagi`,
      });
    }
  }

  /**
   * Validasi payload minimal per tipe aksi (fail-closed): executor tidak
   * boleh menerima payload sampah dari approval yang lolos propose.
   */
  private validatePayload(
    actionType: ApprovalActionType,
    targetId: string | undefined,
    payload: Record<string, unknown>,
  ): void {
    const bad = (msg: string): never => {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `Payload ${actionType} tidak valid: ${msg}`,
      });
    };
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) bad('payload harus object');
    switch (actionType) {
      case 'DISPUTE_RESOLVE': {
        if (!targetId) bad('targetId (disputeId) wajib');
        const d = payload.decision;
        if (d !== 'FULL_BUYER' && d !== 'FULL_SELLER' && d !== 'SPLIT') bad('decision harus FULL_BUYER/FULL_SELLER/SPLIT');
        break;
      }
      case 'INSURANCE_CLAIM_PAY': {
        if (!targetId) bad('targetId (claimId) wajib');
        break;
      }
      case 'WALLET_ADJUST': {
        const t = payload.type;
        if (t !== 'CREDIT' && t !== 'DEBIT') bad('type harus CREDIT/DEBIT');
        if (!Number.isInteger(payload.amount) || (payload.amount as number) <= 0) bad('amount harus integer positif');
        if (typeof payload.reason !== 'string' || payload.reason.trim().length < 5) bad('reason min 5 karakter');
        break;
      }
      case 'COMMERCE_REFUND': {
        if (!targetId) bad('targetId (orderId) wajib');
        break;
      }
      case 'DISBURSEMENT_REOPEN': {
        if (!targetId) bad('targetId (disbursement id) wajib');
        break;
      }
      case 'OPS_SETTING_CHANGE': {
        // SEC-506: targetId = key setting; payload = { value } atau { delete: true }.
        if (!targetId) bad('targetId (key setting) wajib');
        const del = payload['delete'];
        const value = payload['value'];
        if (del !== true && (typeof value !== 'string' || value.trim().length === 0)) {
          bad('payload.value (string tak-kosong) atau payload.delete=true wajib');
        }
        if (typeof value === 'string' && value.length > 2000) bad('payload.value maksimal 2000 karakter');
        if (del !== undefined && del !== true) bad('payload.delete hanya boleh true');
        break;
      }
      default:
        bad('tipe aksi tidak dikenal');
    }
  }

  private toView(r: {
    id: string;
    actionType: string;
    targetId: string | null;
    status: string;
    proposedBy: string;
    proposedAt: Date;
    decidedBy: string | null;
    decidedAt: Date | null;
    executedAt: Date | null;
    expiresAt: Date;
    amountSen: bigint | null;
  }): ApprovalView {
    return {
      approvalId: r.id,
      actionType: r.actionType as ApprovalActionType,
      targetId: r.targetId,
      status: r.status,
      proposedBy: r.proposedBy,
      proposedAt: r.proposedAt.toISOString(),
      decidedBy: r.decidedBy,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      executedAt: r.executedAt?.toISOString() ?? null,
      expiresAt: r.expiresAt.toISOString(),
      amountSen: r.amountSen?.toString() ?? null,
    };
  }
}
