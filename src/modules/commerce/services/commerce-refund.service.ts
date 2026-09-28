import { Injectable, Logger, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  PatunganParticipantStatus,
  JastipParticipantStatus,
  OrderStatus,
  Prisma,
} from '@prisma/client';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { OrderStateService } from '../../orders/order-state.service';

export type CommerceRefundKind = 'patungan' | 'jastip';

export interface CommerceRefundResult {
  kind: CommerceRefundKind;
  participantId: string;
  /** orderId publik (ORD-...) untuk keterbacaan ops. */
  orderPublicId: string | null;
  outcome: 'REFUNDED' | 'ALREADY_REFUNDED' | 'SKIPPED_NO_ORDER' | 'SKIPPED_NOT_REFUNDABLE' | 'FAILED';
  detail?: string;
}

/** Aktor scheduler (bukan admin manusia) untuk jejak orderStatusHistory. */
export const COMMERCE_REFUND_SYSTEM_ACTOR = 'system';

/**
 * M2 (SEC-B ronde 2) — konsumen operasional untuk status REFUND_REQUIRED.
 *
 * Sebelum fix ini, peserta patungan/jastip yang order-nya sudah dibayar
 * (PROCESSING+) dan grup/trip-nya gagal HANYA ditandai REFUND_REQUIRED tanpa
 * ada yang mengeksekusi refund — dana nyangkut di escrow sampai buyer
 * dispute manual.
 *
 * Eksekusi memakai primitif existing `OrderStateService.adminCancelOrder`
 * (cancel order berbayar + refund escrow ke wallet buyer + ledger
 * ORDER_REFUND; untuk QRIS, klaim refund provider + rekonsiliasi existing).
 * TIDAK ada logika uang baru di sini.
 *
 * Idempotensi:
 * - Transisi peserta REFUND_REQUIRED → REFUNDED dijaga conditional
 *   updateMany (predicate status) — dua worker konkuren tidak double-execute.
 * - adminCancelOrder sendiri memakai conditional update di level order
 *   (OPTIMISTIC_LOCK_CONFLICT bila status sudah berubah).
 * - Bila order sudah CANCELLED oleh jalur lain → peserta langsung ditandai
 *   REFUNDED (refund sudah ditangani jalur tersebut).
 * - Order COMPLETED (dana sudah cair ke seller) → TIDAK disentuh (fail
 *   closed); tetap REFUND_REQUIRED + alert untuk tindak lanjut dispute.
 */
@Injectable()
export class CommerceRefundService {
  private readonly logger = new Logger(CommerceRefundService.name);

  constructor(
    private prisma: PrismaService,
    private orderStateService: OrderStateService,
  ) {}

  /** Cari peserta REFUND_REQUIRED dari orderId publik (ORD-...) atau id internal. */
  async executeRefundForOrder(
    orderIdParam: string,
    actorId: string,
    reason: string,
  ): Promise<CommerceRefundResult> {
    const order = await this.prisma.order.findFirst({
      where: { OR: [{ id: orderIdParam }, { orderId: orderIdParam }], deletedAt: null },
      select: { id: true, orderId: true },
    });
    if (!order) {
      throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order tidak ditemukan' });
    }
    const patungan = await this.prisma.patunganParticipant.findFirst({
      where: { orderId: order.id, status: PatunganParticipantStatus.REFUND_REQUIRED },
      select: { id: true },
    });
    if (patungan) return this.executeRefund('patungan', patungan.id, actorId, reason);
    const jastip = await this.prisma.jastipParticipant.findFirst({
      where: { orderId: order.id, status: JastipParticipantStatus.REFUND_REQUIRED },
      select: { id: true },
    });
    if (jastip) return this.executeRefund('jastip', jastip.id, actorId, reason);
    throw new BadRequestException({
      code: ErrorCodes.VALIDATION_ERROR,
      message: 'Tidak ada peserta patungan/jastip berstatus REFUND_REQUIRED untuk order ini',
    });
  }

  async executeRefund(
    kind: CommerceRefundKind,
    participantId: string,
    actorId: string,
    reason: string,
  ): Promise<CommerceRefundResult> {
    const participant = await this.loadParticipant(kind, participantId);
    if (!participant) {
      throw new NotFoundException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Data peserta tidak ditemukan' });
    }
    if (participant.status === 'REFUNDED') {
      return { kind, participantId, orderPublicId: null, outcome: 'ALREADY_REFUNDED' };
    }
    if (!participant.orderId) {
      // Data inkonsisten (REFUND_REQUIRED tanpa order): fail closed — biarkan
      // REFUND_REQUIRED agar ops menindaklanjuti manual.
      this.logger.warn(`Refund ${kind} ${participantId}: tanpa orderId — lewati (butuh tindak lanjut manual)`);
      return { kind, participantId, orderPublicId: null, outcome: 'SKIPPED_NO_ORDER' };
    }
    const order = await this.prisma.order.findUnique({
      where: { id: participant.orderId },
      select: { orderId: true, status: true },
    });
    if (!order) {
      this.logger.warn(`Refund ${kind} ${participantId}: order ${participant.orderId} tidak ditemukan — lewati`);
      return { kind, participantId, orderPublicId: null, outcome: 'SKIPPED_NO_ORDER' };
    }
    if (order.status === OrderStatus.COMPLETED) {
      // Dana sudah cair ke seller — refund otomatis tidak mungkin; jalur
      // dispute existing yang berlaku. Fail closed: status dipertahankan.
      this.logger.error(
        `REFUND_BLOCKED_COMPLETED: ${kind} ${participantId} order ${order.orderId} sudah COMPLETED — butuh dispute manual`,
      );
      return {
        kind,
        participantId,
        orderPublicId: order.orderId,
        outcome: 'SKIPPED_NOT_REFUNDABLE',
        detail: 'Order sudah COMPLETED (dana cair ke seller) — selesaikan via dispute',
      };
    }
    if (order.status === OrderStatus.CANCELLED) {
      // Sudah di-cancel jalur lain (cancel/refund sudah ditangani di sana).
      await this.markRefunded(kind, participantId);
      return { kind, participantId, orderPublicId: order.orderId, outcome: 'ALREADY_REFUNDED' };
    }

    try {
      await this.orderStateService.adminCancelOrder(order.orderId, actorId, reason);
    } catch (e) {
      if (e instanceof ConflictException || (e instanceof BadRequestException && this.isStatusRace(e))) {
        // Race: order berubah status di tengah jalan. Baca ulang — bila sudah
        // CANCELLED, refund ditangani pemenang race.
        const fresh = await this.prisma.order.findUnique({
          where: { id: participant.orderId! },
          select: { status: true },
        });
        if (fresh?.status === OrderStatus.CANCELLED) {
          await this.markRefunded(kind, participantId);
          return { kind, participantId, orderPublicId: order.orderId, outcome: 'ALREADY_REFUNDED' };
        }
      }
      this.logger.error(
        `Refund ${kind} ${participantId} order ${order.orderId} GAGAL: ${e instanceof Error ? e.message : String(e)}`,
      );
      return {
        kind,
        participantId,
        orderPublicId: order.orderId,
        outcome: 'FAILED',
        detail: e instanceof Error ? e.message : String(e),
      };
    }
    await this.markRefunded(kind, participantId);
    this.logger.log(`Refund ${kind} ${participantId} order ${order.orderId} BERHASIL dieksekusi oleh ${actorId}`);
    return { kind, participantId, orderPublicId: order.orderId, outcome: 'REFUNDED' };
  }

  /**
   * Sweep semua peserta REFUND_REQUIRED (dipanggil Bull repeatable tiap
   * 5 menit). Idempoten — aman dijalankan ulang / konkuren.
   */
  async sweepDueRefunds(limit = 50): Promise<{ refunded: number; already: number; skipped: number; failed: number }> {
    const counts = { refunded: 0, already: 0, skipped: 0, failed: 0 };
    const patunganDue = await this.prisma.patunganParticipant.findMany({
      where: { status: PatunganParticipantStatus.REFUND_REQUIRED },
      select: { id: true },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });
    const jastipDue = await this.prisma.jastipParticipant.findMany({
      where: { status: JastipParticipantStatus.REFUND_REQUIRED },
      select: { id: true },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });
    const reason = 'Auto-refund: grup patungan / trip jastip gagal — dana kembali ke buyer';
    for (const p of patunganDue) {
      const r = await this.executeRefund('patungan', p.id, COMMERCE_REFUND_SYSTEM_ACTOR, reason);
      this.tally(counts, r.outcome);
    }
    for (const p of jastipDue) {
      const r = await this.executeRefund('jastip', p.id, COMMERCE_REFUND_SYSTEM_ACTOR, reason);
      this.tally(counts, r.outcome);
    }
    return counts;
  }

  /** Daftar peserta REFUND_REQUIRED untuk monitoring SLA (endpoint admin). */
  async listPendingRefunds(page = 1, limit = 20) {
    const [patungan, jastip] = await Promise.all([
      this.prisma.patunganParticipant.findMany({
        where: { status: PatunganParticipantStatus.REFUND_REQUIRED },
        select: { id: true, userId: true, orderId: true, amount: true, updatedAt: true, groupId: true },
        orderBy: { updatedAt: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.jastipParticipant.findMany({
        where: { status: JastipParticipantStatus.REFUND_REQUIRED },
        select: { id: true, buyerId: true, orderId: true, totalLocked: true, updatedAt: true, tripId: true },
        orderBy: { updatedAt: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    const orderIds = [...patungan, ...jastip].map((p) => p.orderId).filter((id): id is string => !!id);
    const orders = orderIds.length
      ? await this.prisma.order.findMany({
          where: { id: { in: orderIds } },
          select: { id: true, orderId: true, status: true, buyerPayAmount: true },
        })
      : [];
    const orderMap = new Map(orders.map((o) => [o.id, o]));
    const items = [
      ...patungan.map((p) => ({ kind: 'patungan' as const, participantId: p.id, groupOrTripId: p.groupId, userId: p.userId, order: p.orderId ? orderMap.get(p.orderId) ?? null : null, amountSen: p.amount?.toString() ?? null, waitingSince: p.updatedAt })),
      ...jastip.map((p) => ({ kind: 'jastip' as const, participantId: p.id, groupOrTripId: p.tripId, userId: p.buyerId, order: p.orderId ? orderMap.get(p.orderId) ?? null : null, amountSen: p.totalLocked?.toString() ?? null, waitingSince: p.updatedAt })),
    ];
    return { items, page, limit };
  }

  // ── private ────────────────────────────────────────────────────────────

  private tally(
    counts: { refunded: number; already: number; skipped: number; failed: number },
    outcome: CommerceRefundResult['outcome'],
  ): void {
    if (outcome === 'REFUNDED') counts.refunded++;
    else if (outcome === 'ALREADY_REFUNDED') counts.already++;
    else if (outcome === 'FAILED') counts.failed++;
    else counts.skipped++;
  }

  private async loadParticipant(
    kind: CommerceRefundKind,
    participantId: string,
  ): Promise<{ status: string; orderId: string | null } | null> {
    if (kind === 'patungan') {
      return this.prisma.patunganParticipant.findUnique({
        where: { id: participantId },
        select: { status: true, orderId: true },
      });
    }
    return this.prisma.jastipParticipant.findUnique({
      where: { id: participantId },
      select: { status: true, orderId: true },
    });
  }

  /** Transisi REFUND_REQUIRED → REFUNDED dengan predicate status (anti double-execute). */
  private async markRefunded(kind: CommerceRefundKind, participantId: string): Promise<void> {
    if (kind === 'patungan') {
      await this.prisma.patunganParticipant.updateMany({
        where: { id: participantId, status: PatunganParticipantStatus.REFUND_REQUIRED },
        data: { status: PatunganParticipantStatus.REFUNDED },
      });
      return;
    }
    await this.prisma.jastipParticipant.updateMany({
      where: { id: participantId, status: JastipParticipantStatus.REFUND_REQUIRED },
      data: { status: JastipParticipantStatus.REFUNDED },
    });
  }

  private isStatusRace(e: BadRequestException): boolean {
    const msg = e.message.toLowerCase();
    return msg.includes('status') || msg.includes('cancel');
  }
}
