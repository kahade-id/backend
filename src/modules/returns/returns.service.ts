/**
 * GAP-D retur — logika domain (G201–G225).
 *
 * Batasan keras yang dijaga service ini:
 * - Domain BARU dan terpisah: tidak mengubah perilaku order/wallet/dispute
 *   existing. Order tetap COMPLETED selama retur berjalan.
 * - Uang hanya bergerak lewat ReturnsRefundService (satu jalur ledger).
 * - Semua transisi status lewat guard state machine + timeline audit.
 * - Notifikasi best-effort: gagal kirim tidak menggagalkan transaksi domain.
 */
import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, DisputeStatus, OrderStatus, UserAuditAction } from '@prisma/client';
import * as ErrorCodes from '../../common/constants/error-codes';
import { PrismaService } from '../../prisma/prisma.service';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { UploadService } from '../upload/upload.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import { getReturnsDb } from './returns.db';
import { assertLegalReturnTransition, ACTIVE_RETURN_STATUSES } from './returns-state';
import {
  DEFAULT_RETURN_WINDOW_DAYS,
  DEFAULT_SELLER_RESPONSE_HOURS,
  DEFAULT_SHIP_BACK_WINDOW_DAYS,
  DEFAULT_CLARIFICATION_WINDOW_DAYS,
  DEFAULT_REQUIRE_RETURN_SHIPMENT,
  RETURN_EVIDENCE_RETENTION_DAYS,
  MAX_RETURN_ATTACHMENTS,
  RETURN_STATUS_LABEL,
  RETURN_REASON_LABEL,
  RETURN_REJECT_REASON_LABEL,
  RETURN_RESOLUTION_LABEL,
} from './returns.constants';
import { ReturnsNotifyService } from './returns-notify.service';
import {
  ReturnsRefundService,
  RETURN_REFUND_INSUFFICIENT_FUNDS,
} from './returns-refund.service';
import type {
  ReturnActorType,
  ReturnPolicyRow,
  ReturnRequestRow,
  ReturnResolutionType,
  ReturnStatus,
} from './returns.types';
import type {
  CreateReturnDto,
  SellerRespondDto,
  AddReturnNoteDto,
  ShipReturnDto,
  ConfirmReceiptDto,
  ReturnQueueQueryDto,
  AdminReturnActionDto,
  ListReturnsQueryDto,
} from './dto/returns.dto';

export const RETURN_DUPLICATE = 'RETURN_DUPLICATE';
export const RETURN_WINDOW_CLOSED = 'RETURN_WINDOW_CLOSED';
export const RETURN_NOT_ELIGIBLE = 'RETURN_NOT_ELIGIBLE';

const ACTIVE_DISPUTE_STATUSES = ['OPEN', 'ASSIGNED', 'UNDER_REVIEW', 'WAITING_RESPONSE'];

function jakartaDateStr(d = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  return parts.replace(/-/g, '');
}

interface OrderRef {
  id: string;
  orderId: string;
  buyerId: string;
  sellerId: string;
  status: string;
  orderType: string;
  completedAt: Date | null;
  buyerPayAmount: bigint;
}

@Injectable()
export class ReturnsService {
  private readonly logger = new Logger(ReturnsService.name);

  constructor(
    private prisma: PrismaService,
    private serial: WalletTxSerialService,
    private uploadService: UploadService,
    private auditLog: AuditLogService,
    private notify: ReturnsNotifyService,
    private refundService: ReturnsRefundService,
  ) {}

  private db() {
    return getReturnsDb(this.prisma);
  }

  // ------------------------------------------------------------------ policy
  /** G201 — kebijakan per tipe order; fallback ke default bila belum di-seed. */
  async getPolicy(orderType: string): Promise<ReturnPolicyRow> {
    const policy = await this.db().returnPolicy.findFirst({
      where: { orderType, category: null, isActive: true },
    });
    if (policy) return policy;
    return {
      id: 'default',
      orderType,
      category: null,
      returnWindowDays: DEFAULT_RETURN_WINDOW_DAYS,
      sellerResponseHours: DEFAULT_SELLER_RESPONSE_HOURS,
      shipBackWindowDays: DEFAULT_SHIP_BACK_WINDOW_DAYS,
      clarificationWindowDays: DEFAULT_CLARIFICATION_WINDOW_DAYS,
      requireReturnShipment: DEFAULT_REQUIRE_RETURN_SHIPMENT,
      maxRefundBps: null,
      isActive: true,
    };
  }

  private async loadOrderByPublicId(orderPublicId: string): Promise<OrderRef> {
    const order = await this.prisma.order.findFirst({
      where: { orderId: orderPublicId, deletedAt: null },
      select: {
        id: true, orderId: true, buyerId: true, sellerId: true,
        status: true, orderType: true, completedAt: true, buyerPayAmount: true,
      },
    });
    if (!order) {
      throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Pesanan tidak ditemukan.' });
    }
    return order as OrderRef;
  }

  // ------------------------------------------------------- G203/G206 eligibilitas
  /**
   * Kelayakan pengajuan + tanggal akhir pengajuan dari server (G206).
   * Dipakai pre-check di UI dan divalidasi ulang saat create.
   */
  async getEligibility(orderPublicId: string, buyerId: string): Promise<{
    eligible: boolean;
    reason: string | null;
    submitDeadline: Date | null;
    returnWindowDays: number;
    orderPublicId: string;
  }> {
    const order = await this.loadOrderByPublicId(orderPublicId);
    if (order.buyerId !== buyerId) {
      throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Bukan pesanan Anda.' });
    }
    const policy = await this.getPolicy(order.orderType);
    if (order.status !== OrderStatus.COMPLETED || !order.completedAt) {
      return { eligible: false, reason: 'Retur hanya dapat diajukan untuk pesanan yang sudah selesai.', submitDeadline: null, returnWindowDays: policy.returnWindowDays, orderPublicId };
    }
    const submitDeadline = new Date(order.completedAt.getTime() + policy.returnWindowDays * 86_400_000);
    if (Date.now() > submitDeadline.getTime()) {
      return { eligible: false, reason: `Batas pengajuan retur telah lewat (${policy.returnWindowDays} hari setelah pesanan selesai).`, submitDeadline, returnWindowDays: policy.returnWindowDays, orderPublicId };
    }
    const activeDispute = await this.prisma.dispute.findFirst({
      where: { orderId: order.id, status: { in: ACTIVE_DISPUTE_STATUSES as DisputeStatus[] } },
      select: { id: true },
    });
    if (activeDispute) {
      return { eligible: false, reason: 'Pesanan ini sedang dalam sengketa aktif. Selesaikan sengketa terlebih dahulu.', submitDeadline, returnWindowDays: policy.returnWindowDays, orderPublicId };
    }
    const activeReturn = await this.db().returnRequest.findFirst({
      where: { orderId: order.id, status: { in: [...ACTIVE_RETURN_STATUSES] } },
      select: { id: true },
    });
    if (activeReturn) {
      return { eligible: false, reason: 'Sudah ada pengajuan retur aktif untuk pesanan ini.', submitDeadline, returnWindowDays: policy.returnWindowDays, orderPublicId };
    }
    return { eligible: true, reason: null, submitDeadline, returnWindowDays: policy.returnWindowDays, orderPublicId };
  }

  // ------------------------------------------------------------------ create
  /** G203/G204/G205 — buyer mengajukan retur dalam jendela kebijakan. */
  async createReturn(buyerId: string, dto: CreateReturnDto): Promise<ReturnRequestRow> {
    const eligibility = await this.getEligibility(dto.orderId, buyerId);
    if (!eligibility.eligible) {
      throw new BadRequestException({
        code: eligibility.reason?.includes('Batas pengajuan') ? RETURN_WINDOW_CLOSED : RETURN_NOT_ELIGIBLE,
        message: eligibility.reason ?? 'Pengajuan retur tidak memenuhi syarat.',
      });
    }
    const order = await this.loadOrderByPublicId(dto.orderId);
    const policy = await this.getPolicy(order.orderType);
    const itemRef = dto.itemRef?.trim() || null;

    // G218: cek aplikasi + backstop partial unique index di DB.
    const duplicate = await this.db().returnRequest.findFirst({
      where: { orderId: order.id, itemRef, status: { in: [...ACTIVE_RETURN_STATUSES] } },
    });
    if (duplicate) {
      throw new ConflictException({ code: RETURN_DUPLICATE, message: 'Pengajuan retur untuk pesanan/item ini sudah ada dan masih aktif.' });
    }

    // G205: verifikasi fileKey milik buyer via pipeline upload existing.
    const attachments = dto.attachments ?? [];
    if (attachments.length > MAX_RETURN_ATTACHMENTS) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `Maksimal ${MAX_RETURN_ATTACHMENTS} lampiran.` });
    }
    if (attachments.length > 0) {
      const verified = await this.uploadService.verifyEvidenceFileKeysBatch(
        buyerId,
        attachments.map((a) => a.fileKey),
        attachments.map((a) => a.fileType),
        'dispute-evidence',
      );
      const bad = verified.find((v) => v.status !== 'ok');
      if (bad) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `Lampiran tidak valid: ${bad.error ?? bad.fileKey}` });
      }
    }

    const serial = await this.serial.getNextForPrefix('return');
    const returnId = `RTN-${jakartaDateStr()}-${serial.toString().padStart(4, '0')}`;
    const now = new Date();
    const sellerRespondBy = new Date(now.getTime() + policy.sellerResponseHours * 3_600_000);
    const retainUntil = new Date(now.getTime() + RETURN_EVIDENCE_RETENTION_DAYS * 86_400_000);

    let created: ReturnRequestRow;
    try {
      created = await this.db().returnRequest.create({
        data: {
          returnId,
          orderId: order.id,
          itemRef,
          buyerId: order.buyerId,
          sellerId: order.sellerId,
          status: 'REQUESTED' as ReturnStatus,
          reasonCode: dto.reasonCode,
          reasonDetail: dto.reasonDetail?.trim() || null,
          resolutionType: dto.resolutionPreference ?? null,
          sellerRespondBy,
          createdAt: now,
          updatedAt: now,
        },
      });
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException({ code: RETURN_DUPLICATE, message: 'Pengajuan retur ganda terdeteksi (permintaan konkuren).' });
      }
      throw err;
    }

    if (attachments.length > 0) {
      for (const a of attachments) {
        await this.db().returnAttachment.create({
          data: {
            returnRequestId: created.id,
            fileKey: a.fileKey,
            fileName: a.fileName,
            fileType: a.fileType,
            fileSize: a.fileSize,
            uploadedBy: buyerId,
            retainUntil,
          },
        });
      }
    }

    await this.logTimeline(created.id, 'RETURN_CREATED', {
      to: 'REQUESTED', actorId: buyerId, actorRole: 'BUYER',
      metadata: { orderPublicId: order.orderId, reasonCode: dto.reasonCode, submitDeadline: eligibility.submitDeadline, sellerRespondBy },
    });

    // G221 — buyer & seller diberi tahu.
    const reasonLabel = RETURN_REASON_LABEL[dto.reasonCode];
    this.notify.notifyBoth(
      order.buyerId, order.sellerId, 'RETURN_REQUESTED',
      'Pengajuan retur diterima',
      `Pengajuan retur ${returnId} untuk pesanan ${order.orderId} telah diterima dan menunggu tinjauan penjual.`,
      'Pengajuan retur baru',
      `Pembeli mengajukan retur ${returnId} (${reasonLabel}) untuk pesanan ${order.orderId}. Harap ditinjau sebelum ${this.formatWib(sellerRespondBy)}.`,
      created.id, returnId,
    ).catch((e) => this.logger.warn(`notif createReturn gagal: ${(e as Error).message}`));

    this.auditLog.logUserAction({
      userId: buyerId,
      action: UserAuditAction.ORDER_DISPUTE_SUBMITTED,
      entityType: 'ReturnRequest',
      entityId: created.id,
      description: `Buyer mengajukan retur ${returnId} untuk order ${order.orderId} (alasan: ${dto.reasonCode})`,
    });

    return created;
  }

  // ------------------------------------------------------------------- daftar
  async listReturns(userId: string, query: ListReturnsQueryDto) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const where: Record<string, unknown> = {};
    if (query.role === 'seller') where.sellerId = userId;
    else if (query.role === 'buyer') where.buyerId = userId;
    else where.OR = [{ buyerId: userId }, { sellerId: userId }];
    if (query.status) where.status = query.status;
    const [items, total] = await Promise.all([
      this.db().returnRequest.findMany({
        where, orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit, take: limit,
      }),
      this.db().returnRequest.count({ where }),
    ]);
    return {
      items: items.map((r) => this.toListItem(r)),
      page, limit, total,
      totalPages: Math.ceil(total / limit),
    };
  }

  /** G224 — riwayat retur pada detail order. */
  async listByOrder(orderPublicId: string, userId: string) {
    const order = await this.loadOrderByPublicId(orderPublicId);
    if (order.buyerId !== userId && order.sellerId !== userId) {
      throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Tidak berhak melihat pesanan ini.' });
    }
    const items = await this.db().returnRequest.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: 'desc' },
    });
    return items.map((r) => this.toListItem(r));
  }

  async getDetail(returnDbId: string, userId: string, opts: { isAdmin?: boolean } = {}) {
    const ret = await this.mustFind(returnDbId);
    if (!opts.isAdmin && ret.buyerId !== userId && ret.sellerId !== userId) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Tidak berhak melihat pengajuan retur ini.' });
    }
    const db = this.db();
    const [attachments, notes, timeline, shipmentEvents, approval, order] = await Promise.all([
      db.returnAttachment.findMany({ where: { returnRequestId: ret.id }, orderBy: { createdAt: 'asc' } }),
      db.returnNote.findMany({
        where: opts.isAdmin ? { returnRequestId: ret.id } : { returnRequestId: ret.id, visibleToBoth: true },
        orderBy: { createdAt: 'asc' },
      }),
      db.returnTimeline.findMany({ where: { returnRequestId: ret.id }, orderBy: { createdAt: 'asc' } }),
      db.returnShipmentEvent.findMany({ where: { returnRequestId: ret.id }, orderBy: { eventAt: 'asc' } }),
      db.returnRefundApproval.findUnique({ where: { returnRequestId: ret.id } }),
      this.prisma.order.findUnique({ where: { id: ret.orderId }, select: { orderId: true, orderType: true, status: true, completedAt: true } }),
    ]);
    // G212: instruksi kirim balik hanya terlihat setelah APPROVED.
    const showInstructions = ['APPROVED', 'RETURN_SHIPPING', 'RECEIVED', 'RESOLVED_REFUND', 'RESOLVED_EXCHANGE', 'RESOLVED_REPAIR'].includes(ret.status);
    return {
      ...ret,
      returnInstructions: showInstructions ? ret.returnInstructions : null,
      statusLabel: RETURN_STATUS_LABEL[ret.status],
      reasonLabel: RETURN_REASON_LABEL[ret.reasonCode],
      rejectReasonLabel: ret.rejectReasonCode ? RETURN_REJECT_REASON_LABEL[ret.rejectReasonCode] : null,
      resolutionLabel: ret.resolutionType ? RETURN_RESOLUTION_LABEL[ret.resolutionType] : null,
      order: order ? { orderId: order.orderId, orderType: order.orderType, status: order.status, completedAt: order.completedAt } : null,
      attachments: (attachments as Record<string, unknown>[]).map((a) => ({
        id: a.id, fileKey: a.fileKey, fileName: a.fileName, fileType: a.fileType,
        fileSize: a.fileSize, createdAt: a.createdAt,
        downloadUrl: `/v1/upload/s?key=${encodeURIComponent(String(a.fileKey))}`,
      })),
      notes,
      timeline,
      shipmentEvents,
      refundApproval: approval ? {
        id: approval.id, amount: approval.amount.toString(), status: approval.status,
        approvedByRole: approval.approvedByRole, approvedAt: approval.approvedAt,
        executedAt: approval.executedAt, failureReason: approval.failureReason,
        walletTxIds: approval.walletTxIds,
      } : null,
    };
  }

  // ------------------------------------------------------------------ catatan
  /** G216 — negosiasi/notes terlihat dua pihak. */
  async addNote(returnDbId: string, userId: string, dto: AddReturnNoteDto, role: ReturnActorType = 'BUYER') {
    const ret = await this.mustFind(returnDbId);
    this.assertParty(ret, userId, role);
    if (['RESOLVED_REFUND', 'RESOLVED_EXCHANGE', 'RESOLVED_REPAIR', 'CANCELLED', 'EXPIRED', 'ESCALATED'].includes(ret.status)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Pengajuan sudah selesai — tidak dapat menambah catatan.' });
    }
    const note = await this.db().returnNote.create({
      data: { returnRequestId: ret.id, authorId: userId, authorRole: role, message: dto.message.trim(), visibleToBoth: true },
    });
    await this.logTimeline(ret.id, 'NOTE_ADDED', { actorId: userId, actorRole: role, metadata: { noteId: (note as { id: string }).id } });
    const counterpartId = role === 'BUYER' ? ret.sellerId : ret.buyerId;
    const roleLabel = role === 'BUYER' ? 'Pembeli' : role === 'SELLER' ? 'Penjual' : 'Admin';
    this.notify.notifyStage({
      userId: counterpartId, stage: 'RETURN_NOTE_ADDED',
      title: `Catatan baru pada retur ${ret.returnId}`,
      body: `${roleLabel} menambahkan catatan pada pengajuan retur ${ret.returnId}.`,
      returnDbId: ret.id, returnPublicId: ret.returnId,
    }).catch((e) => this.logger.warn(`notif addNote gagal: ${(e as Error).message}`));
    return note;
  }

  // ------------------------------------------------------------- aksi seller
  async sellerStartReview(returnDbId: string, sellerId: string): Promise<ReturnRequestRow> {
    const ret = await this.mustFind(returnDbId);
    this.assertSeller(ret, sellerId);
    return this.transition(ret, 'SELLER_REVIEW', { actorId: sellerId, actorRole: 'SELLER', event: 'SELLER_STARTED_REVIEW' });
  }

  /** G207 — seller: terima / tolak+alasan / minta klarifikasi. */
  async sellerRespond(returnDbId: string, sellerId: string, dto: SellerRespondDto): Promise<ReturnRequestRow> {
    const ret = await this.mustFind(returnDbId);
    this.assertSeller(ret, sellerId);
    if (!['REQUESTED', 'SELLER_REVIEW'].includes(ret.status)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `Tidak dapat merespons pada status ${RETURN_STATUS_LABEL[ret.status]}.` });
    }
    const order = await this.prisma.order.findUnique({ where: { id: ret.orderId }, select: { buyerPayAmount: true } });
    const buyerPayAmount = (order?.buyerPayAmount as bigint | undefined) ?? BigInt(0);
    const policy = await this.getPolicy('PHYSICAL_GOODS'); // pagu mengikuti kebijakan umum

    if (dto.decision === 'REJECT') {
      if (!dto.rejectReasonCode) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Alasan penolakan wajib diisi (G223).' });
      }
      const updated = await this.transition(ret, 'REJECTED', {
        actorId: sellerId, actorRole: 'SELLER', event: 'SELLER_REJECTED',
        patch: { rejectReasonCode: dto.rejectReasonCode, rejectNote: dto.note?.trim() || null, rejectedAt: new Date() },
        metadata: { rejectReasonCode: dto.rejectReasonCode },
      });
      this.notify.notifyStage({
        userId: ret.buyerId, stage: 'RETURN_REJECTED',
        title: `Pengajuan retur ${ret.returnId} ditolak`,
        body: `Penjual menolak pengajuan retur Anda: ${RETURN_REJECT_REASON_LABEL[dto.rejectReasonCode]}. Anda dapat mengajukan eskalasi bila tidak setuju.`,
        returnDbId: ret.id, returnPublicId: ret.returnId,
      }).catch((e) => this.logger.warn(`notif reject gagal: ${(e as Error).message}`));
      return updated;
    }

    if (dto.decision === 'CLARIFY') {
      const updated = await this.transition(ret, 'CLARIFICATION_NEEDED', {
        actorId: sellerId, actorRole: 'SELLER', event: 'SELLER_REQUESTED_CLARIFICATION',
        patch: { clarificationQuestion: dto.note?.trim() || null },
      });
      this.notify.notifyStage({
        userId: ret.buyerId, stage: 'RETURN_CLARIFICATION_NEEDED',
        title: `Penjual meminta klarifikasi (${ret.returnId})`,
        body: dto.note?.trim() || 'Penjual meminta informasi tambahan untuk pengajuan retur Anda.',
        returnDbId: ret.id, returnPublicId: ret.returnId,
      }).catch((e) => this.logger.warn(`notif clarify gagal: ${(e as Error).message}`));
      return updated;
    }

    // APPROVE — G209 opsi penyelesaian.
    const resolutionType: ReturnResolutionType = dto.resolutionType ?? ret.resolutionType ?? 'REFUND';
    let refundAmount: bigint | null = null;
    if (resolutionType === 'REFUND') {
      refundAmount = dto.refundAmountSen !== undefined ? BigInt(dto.refundAmountSen) : buyerPayAmount;
      if (refundAmount <= BigInt(0)) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Nominal refund harus lebih dari nol.' });
      }
      if (refundAmount > buyerPayAmount) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Nominal refund tidak boleh melebihi total yang dibayar pembeli.' });
      }
      if (policy.maxRefundBps !== null && policy.maxRefundBps !== undefined) {
        const cap = (buyerPayAmount * BigInt(policy.maxRefundBps)) / BigInt(10000);
        if (refundAmount > cap) {
          throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Nominal refund melebihi pagu kebijakan.' });
        }
      }
    }
    const shipBy = policy.requireReturnShipment
      ? new Date(Date.now() + policy.shipBackWindowDays * 86_400_000)
      : null;
    const updated = await this.transition(ret, 'APPROVED', {
      actorId: sellerId, actorRole: 'SELLER', event: 'SELLER_APPROVED',
      patch: {
        resolutionType, refundAmount,
        returnInstructions: dto.returnInstructions?.trim() || this.defaultReturnInstructions(ret),
        shipBy, approvedAt: new Date(),
      },
      metadata: { resolutionType, refundAmountSen: refundAmount?.toString() ?? null },
    });

    // G210 — catat persetujuan nominal (TANPA memanggil provider).
    if (resolutionType === 'REFUND' && refundAmount !== null) {
      await this.refundService.createApproval({
        returnRequest: updated, amountSen: refundAmount, approvedBy: sellerId, approvedByRole: 'SELLER',
        maxRefundSen: buyerPayAmount,
      });
      await this.logTimeline(updated.id, 'REFUND_APPROVED', {
        actorId: sellerId, actorRole: 'SELLER',
        metadata: { amountSen: refundAmount.toString(), note: 'Approval tercatat; eksekusi dilakukan setelah barang diterima (G210).' },
      });
    }

    this.notify.notifyBoth(
      ret.buyerId, ret.sellerId, 'RETURN_APPROVED',
      `Retur ${ret.returnId} disetujui`,
      `Pengajuan retur Anda disetujui dengan penyelesaian: ${RETURN_RESOLUTION_LABEL[resolutionType]}.${policy.requireReturnShipment ? ' Silakan kirim balik barang sesuai instruksi.' : ''}`,
      `Anda menyetujui retur ${ret.returnId}`,
      `Retur ${ret.returnId} disetujui (${RETURN_RESOLUTION_LABEL[resolutionType]}).`,
      ret.id, ret.returnId,
    ).catch((e) => this.logger.warn(`notif approve gagal: ${(e as Error).message}`));
    return updated;
  }

  /** Buyer menjawab klarifikasi → kembali ke SELLER_REVIEW. */
  async buyerClarify(returnDbId: string, buyerId: string, dto: AddReturnNoteDto): Promise<ReturnRequestRow> {
    const ret = await this.mustFind(returnDbId);
    this.assertBuyer(ret, buyerId);
    if (ret.status !== 'CLARIFICATION_NEEDED') {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Pengajuan tidak sedang menunggu klarifikasi.' });
    }
    await this.db().returnNote.create({
      data: { returnRequestId: ret.id, authorId: buyerId, authorRole: 'BUYER', message: dto.message.trim(), visibleToBoth: true },
    });
    const updated = await this.transition(ret, 'SELLER_REVIEW', {
      actorId: buyerId, actorRole: 'BUYER', event: 'BUYER_PROVIDED_CLARIFICATION',
      patch: { clarificationQuestion: null },
    });
    this.notify.notifyStage({
      userId: ret.sellerId, stage: 'RETURN_SELLER_RESPOND_NEEDED',
      title: `Klarifikasi diterima (${ret.returnId})`,
      body: `Pembeli telah memberikan klarifikasi untuk retur ${ret.returnId}. Harap lanjutkan tinjauan.`,
      returnDbId: ret.id, returnPublicId: ret.returnId,
    }).catch((e) => this.logger.warn(`notif clarify gagal: ${(e as Error).message}`));
    return updated;
  }

  async buyerCancel(returnDbId: string, buyerId: string): Promise<ReturnRequestRow> {
    const ret = await this.mustFind(returnDbId);
    this.assertBuyer(ret, buyerId);
    const updated = await this.transition(ret, 'CANCELLED', {
      actorId: buyerId, actorRole: 'BUYER', event: 'BUYER_CANCELLED',
      patch: { cancelledAt: new Date() },
    });
    this.notify.notifyStage({
      userId: ret.sellerId, stage: 'RETURN_CANCELLED',
      title: `Retur ${ret.returnId} dibatalkan pembeli`,
      body: `Pembeli membatalkan pengajuan retur ${ret.returnId}.`,
      returnDbId: ret.id, returnPublicId: ret.returnId,
    }).catch((e) => this.logger.warn(`notif cancel gagal: ${(e as Error).message}`));
    return updated;
  }

  /** G212/G213 — buyer lapor resi kirim balik (hanya setelah APPROVED). */
  async submitShipment(returnDbId: string, buyerId: string, dto: ShipReturnDto): Promise<ReturnRequestRow> {
    const ret = await this.mustFind(returnDbId);
    this.assertBuyer(ret, buyerId);
    if (ret.status !== 'APPROVED') {
      // G212: instruksi kirim balik hanya ada setelah APPROVED — cegah di level API.
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Nomor resi hanya dapat dilaporkan setelah retur disetujui.' });
    }
    const updated = await this.transition(ret, 'RETURN_SHIPPING', {
      actorId: buyerId, actorRole: 'BUYER', event: 'BUYER_SHIPPED_RETURN',
      patch: { returnTrackingNumber: dto.trackingNumber.trim(), returnCourier: dto.courier?.trim() || null },
      metadata: { trackingNumber: dto.trackingNumber.trim(), courier: dto.courier?.trim() || null },
    });
    await this.db().returnShipmentEvent.create({
      data: {
        returnRequestId: ret.id,
        trackingNumber: dto.trackingNumber.trim(),
        courier: dto.courier?.trim() || null,
        status: 'LABEL_CREATED',
        location: null,
      },
    });
    this.notify.notifyStage({
      userId: ret.sellerId, stage: 'RETURN_SHIPPED_BACK',
      title: `Barang retur dikirim (${ret.returnId})`,
      body: `Pembeli mengirim balik barang untuk retur ${ret.returnId}. Resi: ${dto.trackingNumber.trim()}.`,
      returnDbId: ret.id, returnPublicId: ret.returnId,
    }).catch((e) => this.logger.warn(`notif ship gagal: ${(e as Error).message}`));
    return updated;
  }

  /** G215 — seller konfirmasi barang retur diterima sebelum kompensasi. */
  async confirmReceipt(returnDbId: string, sellerId: string, dto: ConfirmReceiptDto): Promise<ReturnRequestRow> {
    const ret = await this.mustFind(returnDbId);
    this.assertSeller(ret, sellerId);
    if (ret.status !== 'RETURN_SHIPPING') {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Belum ada pengiriman balik yang perlu dikonfirmasi.' });
    }
    const updated = await this.transition(ret, 'RECEIVED', {
      actorId: sellerId, actorRole: 'SELLER', event: 'SELLER_CONFIRMED_RECEIPT',
      patch: { receivedAt: new Date(), receivedNote: dto.note?.trim() || null },
      metadata: { condition: dto.condition ?? null },
    });
    await this.db().returnShipmentEvent.create({
      data: {
        returnRequestId: ret.id,
        trackingNumber: ret.returnTrackingNumber ?? '-',
        courier: ret.returnCourier,
        status: 'DELIVERED',
        location: null,
      },
    });
    this.notify.notifyStage({
      userId: ret.buyerId, stage: 'RETURN_RECEIVED',
      title: `Barang retur diterima (${ret.returnId})`,
      body: `Penjual mengonfirmasi barang retur ${ret.returnId} telah diterima. Penyelesaian segera diproses.`,
      returnDbId: ret.id, returnPublicId: ret.returnId,
    }).catch((e) => this.logger.warn(`notif receive gagal: ${(e as Error).message}`));
    return updated;
  }

  /**
   * Finalisasi penyelesaian (G209). Untuk REFUND: memakai approval yang sudah
   * tercatat (G210) lalu eksekusi SATU jalur ledger (G211). Idempoten.
   */
  async resolveReturn(
    returnDbId: string,
    actorId: string,
    actorRole: ReturnActorType,
    outcome?: 'REFUND' | 'EXCHANGE' | 'REPAIR',
    note?: string,
  ): Promise<ReturnRequestRow> {
    const ret = await this.mustFind(returnDbId);
    if (actorRole === 'SELLER') this.assertSeller(ret, actorId);
    else if (actorRole === 'BUYER') this.assertBuyer(ret, actorId);

    const policy = await this.getPolicy('PHYSICAL_GOODS');
    const needsShipment = policy.requireReturnShipment;
    if (needsShipment && ret.status !== 'RECEIVED') {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Kompensasi hanya dapat diproses setelah penjual mengonfirmasi barang retur diterima (G215).',
      });
    }
    if (!needsShipment && ret.status !== 'APPROVED') {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Status tidak memungkinkan penyelesaian.' });
    }

    const effectiveOutcome = outcome ?? (ret.resolutionType === 'MUTUAL_AGREED' ? undefined : ret.resolutionType as 'REFUND' | 'EXCHANGE' | 'REPAIR' | undefined);
    if (!effectiveOutcome) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Hasil penyelesaian (refund/tukar/perbaiki) wajib ditentukan untuk kesepakatan bersama.' });
    }
    const terminalStatus: ReturnStatus =
      effectiveOutcome === 'REFUND' ? 'RESOLVED_REFUND' : effectiveOutcome === 'EXCHANGE' ? 'RESOLVED_EXCHANGE' : 'RESOLVED_REPAIR';

    if (effectiveOutcome === 'REFUND') {
      await this.executeRefundForReturn(ret, actorId, actorRole);
    }

    const updated = await this.transition(ret, terminalStatus, {
      actorId, actorRole, event: 'RETURN_RESOLVED',
      patch: { resolvedAt: new Date() },
      metadata: { outcome: effectiveOutcome, note: note?.trim() || null },
    });

    const stage = effectiveOutcome === 'REFUND' ? 'RETURN_REFUND_EXECUTED' : 'RETURN_RESOLVED';
    this.notify.notifyBoth(
      ret.buyerId, ret.sellerId, stage,
      `Retur ${ret.returnId} selesai`,
      effectiveOutcome === 'REFUND'
        ? `Dana refund untuk retur ${ret.returnId} telah dikembalikan ke dompet Anda.`
        : `Retur ${ret.returnId} selesai (${RETURN_RESOLUTION_LABEL[effectiveOutcome as ReturnResolutionType]}).`,
      `Retur ${ret.returnId} selesai`,
      `Retur ${ret.returnId} selesai (${RETURN_RESOLUTION_LABEL[effectiveOutcome as ReturnResolutionType]}).`,
      ret.id, ret.returnId,
    ).catch((e) => this.logger.warn(`notif resolve gagal: ${(e as Error).message}`));
    return updated;
  }

  /** G217 — eskalasi ke sengketa TANPA case ganda: link dispute existing. */
  async escalateToDispute(returnDbId: string, userId: string, role: ReturnActorType, reason?: string): Promise<ReturnRequestRow> {
    const ret = await this.mustFind(returnDbId);
    if (role !== 'ADMIN') this.assertParty(ret, userId, role);
    if (!['REQUESTED', 'SELLER_REVIEW', 'CLARIFICATION_NEEDED', 'REJECTED', 'APPROVED', 'RETURN_SHIPPING', 'RECEIVED'].includes(ret.status)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Status saat ini tidak dapat dieskalasi.' });
    }
    // Link ke dispute AKTIF yang sudah ada untuk order ini — jangan buat baru.
    const existingDispute = await this.prisma.dispute.findFirst({
      where: { orderId: ret.orderId, status: { in: ACTIVE_DISPUTE_STATUSES as DisputeStatus[] } },
      select: { id: true },
    });
    const updated = await this.transition(ret, 'ESCALATED', {
      actorId: userId, actorRole: role, event: 'RETURN_ESCALATED',
      patch: { escalatedAt: new Date(), disputeId: existingDispute?.id ?? null },
      metadata: { reason: reason?.trim() || null, linkedDisputeId: existingDispute?.id ?? null, newDisputeCreated: false },
    });
    // G220 — jejak audit eskalasi. admin_audit_log hanya untuk admin (kolom
    // adminId wajib merujuk AdminUser yang valid); buyer/seller memakai
    // auditLog user biasa. Jejak utama tetap ReturnTimeline via transition().
    if (role === 'ADMIN') {
      this.auditLog.logAdminAction({
        adminId: userId,
        action: AuditAction.DISPUTE_ESCALATED,
        targetType: 'ReturnRequest',
        targetId: ret.id,
        description: `Retur ${ret.returnId} dieskalasi oleh admin${existingDispute ? ` — ditautkan ke sengketa existing ${existingDispute.id}` : ' — BELUM ada sengketa aktif, perlu konversi manual oleh support'}`,
        ipAddress: 'system',
      });
    } else {
      this.auditLog.logUserAction({
        userId,
        action: UserAuditAction.ORDER_DISPUTE_SUBMITTED,
        entityType: 'ReturnRequest',
        entityId: ret.id,
        description: `Retur ${ret.returnId} dieskalasi oleh ${role}${existingDispute ? ` — ditautkan ke sengketa existing ${existingDispute.id}` : ''}`,
      });
    }
    this.notify.notifyBoth(
      ret.buyerId, ret.sellerId, 'RETURN_ESCALATED',
      `Retur ${ret.returnId} dieskalasi`,
      `Pengajuan retur ${ret.returnId} diteruskan ke tim sengketa Kahade.${existingDispute ? '' : ' Tim support akan menghubungi Anda.'}`,
      `Retur ${ret.returnId} dieskalasi`,
      `Pengajuan retur ${ret.returnId} diteruskan ke tim sengketa Kahade.`,
      ret.id, ret.returnId,
    ).catch((e) => this.logger.warn(`notif escalate gagal: ${(e as Error).message}`));
    return updated;
  }

  // ------------------------------------------------------------- admin queue
  /** G219 — antrean admin + filter umur kasus. */
  async adminQueue(query: ReturnQueueQueryDto) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const where: Record<string, unknown> = {};
    if (query.status && query.status !== 'ALL') where.status = query.status;
    if (query.minAgeHours !== undefined || query.maxAgeHours !== undefined) {
      const now = Date.now();
      const createdAt: Record<string, Date> = {};
      if (query.maxAgeHours !== undefined) createdAt.gte = new Date(now - query.maxAgeHours * 3_600_000);
      if (query.minAgeHours !== undefined) createdAt.lte = new Date(now - query.minAgeHours * 3_600_000);
      where.createdAt = createdAt;
    }
    if (query.search) {
      where.OR = [
        { returnId: { contains: query.search, mode: 'insensitive' } },
        { returnTrackingNumber: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const [items, total] = await Promise.all([
      this.db().returnRequest.findMany({ where, orderBy: { createdAt: 'asc' }, skip: (page - 1) * limit, take: limit }),
      this.db().returnRequest.count({ where }),
    ]);
    const now = Date.now();
    return {
      items: items.map((r) => ({ ...this.toListItem(r), ageHours: Math.floor((now - r.createdAt.getTime()) / 3_600_000) })),
      page, limit, total, totalPages: Math.ceil(total / limit),
    };
  }

  /** Aksi admin: approve / reject / escalate / force-resolve. */
  async adminAct(returnDbId: string, adminId: string, dto: AdminReturnActionDto): Promise<ReturnRequestRow> {
    const ret = await this.mustFind(returnDbId);
    switch (dto.action) {
      case 'APPROVE':
        return this.sellerRespondAsAdmin(ret, adminId, {
          decision: 'APPROVE',
          resolutionType: dto.resolutionType ?? ret.resolutionType ?? 'REFUND',
          refundAmountSen: dto.refundAmountSen,
          note: dto.note,
        });
      case 'REJECT':
        return this.sellerRespondAsAdmin(ret, adminId, {
          decision: 'REJECT',
          rejectReasonCode: dto.rejectReasonCode ?? 'LAINNYA',
          note: dto.note,
        });
      case 'ESCALATE':
        return this.escalateToDispute(returnDbId, adminId, 'ADMIN', dto.note);
      case 'FORCE_RESOLVE_REFUND':
      case 'FORCE_RESOLVE_EXCHANGE':
      case 'FORCE_RESOLVE_REPAIR': {
        const outcome = dto.action === 'FORCE_RESOLVE_REFUND' ? 'REFUND' : dto.action === 'FORCE_RESOLVE_EXCHANGE' ? 'EXCHANGE' : 'REPAIR';
        // Force-resolve: bawa ke RECEIVED dulu bila kebijakan butuh kirim balik
        // tapi admin memutuskan tanpa menunggu barang (dicatat di audit).
        let current = ret;
        const policy = await this.getPolicy('PHYSICAL_GOODS');
        if (policy.requireReturnShipment && current.status === 'APPROVED') {
          current = await this.transition(current, 'RECEIVED', {
            actorId: adminId, actorRole: 'ADMIN', event: 'ADMIN_SKIPPED_RECEIPT',
            patch: { receivedAt: new Date(), receivedNote: 'Dilewati oleh admin (force-resolve).' },
          });
        }
        return this.resolveReturn(current.id, adminId, 'ADMIN', outcome, dto.note ?? 'Force-resolve oleh admin.');
      }
    }
  }

  // --------------------------------------------------------------- cron hooks
  /** G208 — SLA respons seller lewat → eskalasi otomatis ke support. */
  async expireSellerSla(now = new Date()): Promise<number> {
    const breached = await this.db().returnRequest.findMany({
      where: { status: { in: ['REQUESTED', 'SELLER_REVIEW'] }, sellerRespondBy: { lt: now } },
      take: 200,
    });
    for (const ret of breached) {
      try {
        await this.transition(ret, 'ESCALATED', {
          actorRole: 'SYSTEM', event: 'SELLER_SLA_BREACHED_AUTO_ESCALATED',
          patch: { escalatedAt: now },
          metadata: { sellerRespondBy: ret.sellerRespondBy },
        });
        // Jejak audit = ReturnTimeline via transition() di atas (G220). Tidak
        // menulis admin_audit_log di sini: kolom adminId wajib merujuk
        // AdminUser yang valid, sedangkan aksi ini dilakukan sistem.
        this.notify.notifyBoth(
          ret.buyerId, ret.sellerId, 'RETURN_ESCALATED',
          `Retur ${ret.returnId} diteruskan ke support`,
          `Penjual tidak merespons tepat waktu, pengajuan retur ${ret.returnId} diteruskan ke tim support Kahade.`,
          `Retur ${ret.returnId} diteruskan ke support`,
          `Anda tidak merespons pengajuan retur ${ret.returnId} dalam batas waktu — kasus diteruskan ke tim support.`,
          ret.id, ret.returnId,
        ).catch((e) => this.logger.warn(`notif sla gagal: ${(e as Error).message}`));
      } catch (err) {
        this.logger.warn(`expireSellerSla gagal untuk ${ret.returnId}: ${(err as Error).message}`);
      }
    }
    return breached.length;
  }

  /** Kedaluwarsa: kirim balik tak dilakukan (APPROVED→EXPIRED) & klarifikasi tak dijawab. */
  async expireStale(now = new Date()): Promise<number> {
    let count = 0;
    const unshipped = await this.db().returnRequest.findMany({
      where: { status: 'APPROVED', shipBy: { lt: now } }, take: 200,
    });
    for (const ret of unshipped) {
      try {
        await this.transition(ret, 'EXPIRED', { actorRole: 'SYSTEM', event: 'SHIP_BACK_WINDOW_EXPIRED', patch: { expiredAt: now } });
        count++;
      } catch (err) { this.logger.warn(`expireStale ship gagal ${ret.returnId}: ${(err as Error).message}`); }
    }
    const unanswered = await this.db().returnRequest.findMany({
      where: { status: 'CLARIFICATION_NEEDED', updatedAt: { lt: new Date(now.getTime() - DEFAULT_CLARIFICATION_WINDOW_DAYS * 86_400_000) } },
      take: 200,
    });
    for (const ret of unanswered) {
      try {
        await this.transition(ret, 'EXPIRED', { actorRole: 'SYSTEM', event: 'CLARIFICATION_WINDOW_EXPIRED', patch: { expiredAt: now } });
        count++;
      } catch (err) { this.logger.warn(`expireStale clarify gagal ${ret.returnId}: ${(err as Error).message}`); }
    }
    return count;
  }

  /** G222 — purge file bukti yang melewati masa retensi. */
  async purgeExpiredEvidence(now = new Date()): Promise<number> {
    const expired = await this.db().returnAttachment.findMany({
      where: { retainUntil: { lt: now }, purgedAt: null },
      take: 200,
    });
    let purged = 0;
    for (const att of expired) {
      const a = att as unknown as { id: string; fileKey: string; returnRequestId: string; uploadedBy: string };
      try {
        // Hapus file di storage via API publik UploadService (cleanupFileKeys
        // memvalidasi kepemilikan: segments[2] === uploadedBy).
        await this.uploadService.cleanupFileKeys(a.uploadedBy, [a.fileKey]).catch(() => undefined);
        await this.db().returnAttachment.update({ where: { id: a.id }, data: { purgedAt: now, fileKey: '[purged]' } });
        await this.logTimeline(a.returnRequestId, 'EVIDENCE_PURGED', {
          actorRole: 'SYSTEM', metadata: { attachmentId: a.id, reason: 'retention-expired' },
        });
        purged++;
      } catch (err) {
        this.logger.warn(`purge evidence gagal ${a.id}: ${(err as Error).message}`);
      }
    }
    return purged;
  }

  // ------------------------------------------------------------------ private
  private async mustFind(returnDbId: string): Promise<ReturnRequestRow> {
    const ret = await this.db().returnRequest.findUnique({ where: { id: returnDbId } });
    if (!ret) throw new NotFoundException({ code: 'RETURN_NOT_FOUND', message: 'Pengajuan retur tidak ditemukan.' });
    return ret;
  }

  private assertBuyer(ret: ReturnRequestRow, userId: string): void {
    if (ret.buyerId !== userId) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Hanya pembeli yang dapat melakukan aksi ini.' });
  }

  private assertSeller(ret: ReturnRequestRow, userId: string): void {
    if (ret.sellerId !== userId) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Hanya penjual yang dapat melakukan aksi ini.' });
  }

  private assertParty(ret: ReturnRequestRow, userId: string, role: ReturnActorType): void {
    if (role === 'BUYER') this.assertBuyer(ret, userId);
    else if (role === 'SELLER') this.assertSeller(ret, userId);
    else throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Peran tidak valid untuk aksi ini.' });
  }

  /**
   * Transisi status terpusat: guard legal → update atomik (optimistic via
   * updateMany where status=from) → timeline audit. G220.
   */
  private async transition(
    ret: ReturnRequestRow,
    to: ReturnStatus,
    opts: {
      actorId?: string;
      actorRole: ReturnActorType;
      event: string;
      patch?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    },
  ): Promise<ReturnRequestRow> {
    assertLegalReturnTransition(ret.status, to);
    const from = ret.status;
    const updated = await this.db().returnRequest.updateMany({
      where: { id: ret.id, status: from },
      data: { status: to as never, updatedAt: new Date(), ...(opts.patch ?? {}) },
    });
    if (updated.count === 0) {
      throw new ConflictException({
        code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
        message: 'Status pengajuan berubah saat diproses, silakan muat ulang.',
      });
    }
    const fresh = await this.mustFind(ret.id);
    await this.logTimeline(ret.id, opts.event, {
      from, to, actorId: opts.actorId, actorRole: opts.actorRole, metadata: opts.metadata,
    });
    return fresh;
  }

  private async logTimeline(
    returnRequestId: string,
    event: string,
    opts: { from?: ReturnStatus; to?: ReturnStatus; actorId?: string; actorRole?: ReturnActorType; metadata?: Record<string, unknown> },
  ): Promise<void> {
    await this.db().returnTimeline.create({
      data: {
        returnRequestId, event,
        fromStatus: (opts.from ?? null) as never,
        toStatus: (opts.to ?? null) as never,
        actorId: opts.actorId ?? null,
        actorRole: opts.actorRole ?? 'SYSTEM',
        metadata: opts.metadata ?? undefined,
      },
    }).catch((e) => this.logger.warn(`timeline gagal: ${(e as Error).message}`));
  }

  /** Eksekusi refund idempoten untuk satu return (G210/G211). */
  private async executeRefundForReturn(ret: ReturnRequestRow, actorId: string, actorRole: ReturnActorType): Promise<void> {
    const approval = await this.refundService.getApproval(ret.id);
    if (!approval) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Belum ada persetujuan refund untuk retur ini.' });
    }
    if (approval.status === 'EXECUTED') return; // idempoten: sudah dieksekusi
    const claimed = await this.refundService.claimExecution(approval.id);
    if (!claimed) {
      const fresh = await this.refundService.getApproval(ret.id);
      if (fresh?.status === 'EXECUTED') return;
      throw new ConflictException({ code: 'RETURN_REFUND_IN_PROGRESS', message: 'Refund sedang diproses oleh proses lain.' });
    }
    try {
      const [sellerWallet, buyerWallet] = await Promise.all([
        this.prisma.wallet.findFirst({ where: { userId: ret.sellerId }, select: { id: true } }),
        this.prisma.wallet.findFirst({ where: { userId: ret.buyerId }, select: { id: true } }),
      ]);
      if (!sellerWallet || !buyerWallet) {
        throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Dompet penjual/pembeli tidak ditemukan.' });
      }
      const txIds = await this.refundService.executeLedgerRefund({
        sellerWalletId: sellerWallet.id,
        buyerWalletId: buyerWallet.id,
        orderDbId: ret.orderId,
        returnPublicId: ret.returnId,
        amountSen: approval.amount,
      });
      await this.refundService.markExecuted(approval.id, txIds);
      await this.logTimeline(ret.id, 'REFUND_EXECUTED', {
        actorId, actorRole,
        metadata: { amountSen: approval.amount.toString(), walletTxIds: txIds },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await this.refundService.markFailed(approval.id, reason);
      await this.logTimeline(ret.id, 'REFUND_FAILED', { actorId, actorRole, metadata: { reason } });
      if ((err as { code?: string })?.code === RETURN_REFUND_INSUFFICIENT_FUNDS) {
        // Dana seller kurang → biarkan FAILED agar admin menindaklanjuti; jangan hanguskan.
        this.notify.notifyStage({
          userId: ret.sellerId, stage: 'RETURN_REFUND_APPROVED',
          title: `Saldo tidak cukup untuk refund ${ret.returnId}`,
          body: `Refund ${ret.returnId} gagal dieksekusi karena saldo Anda tidak mencukupi. Harap top-up atau hubungi support.`,
          returnDbId: ret.id, returnPublicId: ret.returnId,
        }).catch(() => undefined);
      }
      throw err;
    }
  }

  private async sellerRespondAsAdmin(
    ret: ReturnRequestRow, adminId: string,
    dto: { decision: 'APPROVE' | 'REJECT'; resolutionType?: ReturnResolutionType; refundAmountSen?: number; rejectReasonCode?: never; note?: string } |
         { decision: 'REJECT'; rejectReasonCode: 'MELEWATI_BATAS_WAKTU' | 'BARANG_TIDAK_RUSAK' | 'KLAIM_TIDAK_VALID' | 'BUKTI_TIDAK_CUKUP' | 'BARANG_SUDAH_DIGUNAKAN' | 'KERUSAKAN_AKIBAT_PEMBELI' | 'DILUAR_CAKUPAN_KEBIJAKAN' | 'LAINNYA'; note?: string },
  ): Promise<ReturnRequestRow> {
    // Reuse logika sellerRespond dengan actorRole ADMIN — duplikasi minimal.
    if (dto.decision === 'REJECT') {
      const r = dto as { rejectReasonCode: 'LAINNYA'; note?: string };
      if (!['REQUESTED', 'SELLER_REVIEW'].includes(ret.status)) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Status tidak memungkinkan penolakan.' });
      }
      const updated = await this.transition(ret, 'REJECTED', {
        actorId: adminId, actorRole: 'ADMIN', event: 'ADMIN_REJECTED',
        patch: { rejectReasonCode: r.rejectReasonCode, rejectNote: r.note?.trim() || null, rejectedAt: new Date() },
      });
      this.notify.notifyStage({ userId: ret.buyerId, stage: 'RETURN_REJECTED', title: `Retur ${ret.returnId} ditolak admin`, body: `Tim Kahade menolak pengajuan retur Anda: ${RETURN_REJECT_REASON_LABEL[r.rejectReasonCode]}.`, returnDbId: ret.id, returnPublicId: ret.returnId }).catch(() => undefined);
      return updated;
    }
    const a = dto as { resolutionType?: ReturnResolutionType; refundAmountSen?: number; note?: string };
    if (!['REQUESTED', 'SELLER_REVIEW'].includes(ret.status)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Status tidak memungkinkan persetujuan.' });
    }
    const order = await this.prisma.order.findUnique({ where: { id: ret.orderId }, select: { buyerPayAmount: true } });
    const buyerPayAmount = (order?.buyerPayAmount as bigint | undefined) ?? BigInt(0);
    const resolutionType = a.resolutionType ?? ret.resolutionType ?? 'REFUND';
    let refundAmount: bigint | null = null;
    if (resolutionType === 'REFUND') {
      refundAmount = a.refundAmountSen !== undefined ? BigInt(a.refundAmountSen) : buyerPayAmount;
      if (refundAmount <= BigInt(0) || refundAmount > buyerPayAmount) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Nominal refund tidak valid.' });
      }
    }
    const policy = await this.getPolicy('PHYSICAL_GOODS');
    const updated = await this.transition(ret, 'APPROVED', {
      actorId: adminId, actorRole: 'ADMIN', event: 'ADMIN_APPROVED',
      patch: {
        resolutionType, refundAmount,
        returnInstructions: this.defaultReturnInstructions(ret),
        shipBy: policy.requireReturnShipment ? new Date(Date.now() + policy.shipBackWindowDays * 86_400_000) : null,
        approvedAt: new Date(),
      },
      metadata: { resolutionType, refundAmountSen: refundAmount?.toString() ?? null },
    });
    if (resolutionType === 'REFUND' && refundAmount !== null) {
      await this.refundService.createApproval({
        returnRequest: updated, amountSen: refundAmount, approvedBy: adminId, approvedByRole: 'ADMIN', maxRefundSen: buyerPayAmount,
      });
    }
    return updated;
  }

  private defaultReturnInstructions(ret: ReturnRequestRow): string {
    return (
      'Kirim balik barang ke alamat penjual dengan kemasan yang aman. ' +
      `Cantumkan nomor retur ${ret.returnId} di paket. Setelah resi dilaporkan, penjual akan mengonfirmasi penerimaan barang.`
    );
  }

  private toListItem(r: ReturnRequestRow) {
    return {
      id: r.id,
      returnId: r.returnId,
      orderId: r.orderId,
      itemRef: r.itemRef,
      status: r.status,
      statusLabel: RETURN_STATUS_LABEL[r.status],
      reasonCode: r.reasonCode,
      reasonLabel: RETURN_REASON_LABEL[r.reasonCode],
      resolutionType: r.resolutionType,
      resolutionLabel: r.resolutionType ? RETURN_RESOLUTION_LABEL[r.resolutionType] : null,
      refundAmount: r.refundAmount?.toString() ?? null,
      sellerRespondBy: r.sellerRespondBy,
      shipBy: r.shipBy,
      returnTrackingNumber: r.returnTrackingNumber,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  private isUniqueViolation(err: unknown): boolean {
    return (err as { code?: string })?.code === 'P2002';
  }

  private formatWib(d: Date): string {
    return new Intl.DateTimeFormat('id-ID', {
      timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }).format(d) + ' WIB';
  }
}
