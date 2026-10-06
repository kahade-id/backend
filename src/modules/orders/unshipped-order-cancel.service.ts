import { Injectable, Logger, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { OrderStatus, OrderCancelReason, DisputeStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { OrderStateService } from './order-state.service';
import { PROCESSING_DEADLINE_DAYS, PREORDER_DEFAULT_DEADLINE_DAYS } from '../../common/constants/app.constants';
import * as ErrorCodes from '../../common/constants/error-codes';

/**
 * Wave 3 P0 (2026-09-28) — buyer stuck: seller tidak kirim, tidak ada
 * auto-cancel/refund.
 *
 * Temuan E2E black-box: tidak ada sweep untuk order escrow regular yang
 * PROCESSING melewati batas kirim — hanya ada auto-cancel unpaid (2 hari),
 * auto-cancel unconfirmed (1 hari), dan auto-complete IN_DELIVERY. Dana buyer
 * nyangkut di escrow sampai buyer dispute manual.
 *
 * KEPUTUSAN USER FINAL: order yang melewati batas kirim tanpa pengiriman
 * HARUS auto-cancel + auto-refund ke buyer (otomatis via scheduler +
 * endpoint admin manual sebagai SLA fallback).
 *
 * Batas kirim = orders.processingDeadlineAt (diset = paidAt + 2 hari di
 * payOrder & QRIS settlement). Order lama yang processingDeadlineAt-nya NULL
 * (kolom tidak pernah diisi sebelum fix ini) di-backfill implisit dari
 * paidAt + 2 hari di predikat sweep — tanpa migrasi data.
 *
 * Eksekusi memakai primitif existing `OrderStateService.adminCancelOrder`
 * (cancel + refund escrow ke wallet buyer + ledger ORDER_REFUND + refund
 * provider QRIS best-effort). TIDAK ada logika uang baru di sini.
 *
 * Fail-closed / idempoten:
 * - Predikat status PROCESSING + conditional updateMany di adminCancelOrder
 *   (OPTIMISTIC_LOCK_CONFLICT bila status sudah berubah) — dua worker
 *   konkuren tidak double-cancel / double-refund.
 * - Order dengan dispute BERJALAN (status dispute != RESOLVED) di-skip
 *   eksplisit — tidak tabrakan dengan alur dispute. (Membuka dispute
 *   memindahkan order ke status DISPUTED, jadi predikat PROCESSING saja
 *   sudah menyaring; cek ini lapis kedua untuk race.)
 * - Order sudah CANCELLED → ALREADY_HANDLED (refund ditangani pemenang race).
 * - Order COMPLETED / IN_DELIVERY → tidak disentuh.
 */
@Injectable()
export class UnshippedOrderCancelService {
  private readonly logger = new Logger(UnshippedOrderCancelService.name);

  constructor(
    private prisma: PrismaService,
    private orderStateService: OrderStateService,
  ) {}

  /** Batas kirim dalam ms — dipakai untuk backfill implisit order lama. */
  static processingDeadlineMs(): number {
    return PROCESSING_DEADLINE_DAYS * 24 * 3600_000;
  }

  /**
   * Kandidat sweep: PROCESSING + belum ada shipment (shippedAt NULL) +
   * melewati batas kirim + tanpa dispute berjalan.
   *
   * TX-UNIFIED-V2 (P1-3): PREORDER dikecualikan dari SLA 2 hari. Untuk order
   * baru, processingDeadlineAt sudah = estimasi (atau paidAt+30 hari), jadi
   * cabang utama bekerja otomatis. Cabang backfill legacy dibuat sadar
   * fulfillment agar preorder lama tidak terbatal prematur.
   */
  async findDueUnshippedOrders(limit = 200, now: Date = new Date()) {
    const legacyCutoff = new Date(now.getTime() - UnshippedOrderCancelService.processingDeadlineMs());
    const preorderLegacyCutoff = new Date(now.getTime() - PREORDER_DEFAULT_DEADLINE_DAYS * 24 * 3600_000);
    return this.prisma.order.findMany({
      where: {
        status: OrderStatus.PROCESSING,
        deletedAt: null,
        shippedAt: null,
        OR: [
          {
            processingDeadlineAt: { lt: now },
            // Guard eksplisit: PREORDER dengan estimasi di masa depan tidak
            // boleh tersentuh walau processingDeadlineAt-nya anomali.
            NOT: { fulfillment: 'PREORDER', preorderEstimatedDate: { gt: now } },
          },
          // Backfill implisit: order lama yang processingDeadlineAt-nya NULL.
          // P1-3: bedakan cutoff — PREORDER lama pakai 30 hari, bukan 2 hari.
          {
            processingDeadlineAt: null,
            OR: [
              { fulfillment: { not: 'PREORDER' }, paidAt: { lt: legacyCutoff } },
              { fulfillment: 'PREORDER', paidAt: { lt: preorderLegacyCutoff } },
            ],
          },
        ],
        // Satu order maksimal satu dispute (orderId unique di Dispute).
        dispute: { isNot: { status: { in: OPEN_DISPUTE_STATUSES } } },
      },
      select: {
        id: true,
        orderId: true,
        buyerId: true,
        buyerPayAmount: true,
        processingDeadlineAt: true,
        paidAt: true,
        fulfillment: true,
        preorderEstimatedDate: true,
      },
      orderBy: [{ processingDeadlineAt: 'asc' }, { paidAt: 'asc' }],
      take: limit,
    });
  }

  /**
   * Eksekusi cancel + refund untuk SATU order (dipakai sweep & endpoint
   * admin manual). Predikat due yang sama — endpoint manual hanyalah
   * pemicu sinkron dari logika ini.
   */
  async cancelUnshippedOrder(
    orderIdParam: string,
    actorId: string,
    reason: string,
  ): Promise<UnshippedCancelResult> {
    const order = await this.prisma.order.findFirst({
      where: { OR: [{ id: orderIdParam }, { orderId: orderIdParam }], deletedAt: null },
      select: {
        id: true,
        orderId: true,
        status: true,
        shippedAt: true,
        processingDeadlineAt: true,
        paidAt: true,
        buyerId: true,
        buyerPayAmount: true,
      },
    });
    if (!order) {
      throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order tidak ditemukan' });
    }
    if (order.status === OrderStatus.CANCELLED) {
      return { orderId: order.orderId, outcome: 'ALREADY_HANDLED', detail: 'Order sudah CANCELLED' };
    }
    if (order.status !== OrderStatus.PROCESSING || order.shippedAt) {
      return {
        orderId: order.orderId,
        outcome: 'SKIPPED_NOT_DUE',
        detail: `Status ${order.status} — bukan PROCESSING yang belum dikirim`,
      };
    }
    if (!this.isPastShipDeadline(order.processingDeadlineAt, order.paidAt, new Date())) {
      return { orderId: order.orderId, outcome: 'SKIPPED_NOT_DUE', detail: 'Belum melewati batas kirim' };
    }
    const openDispute = await this.prisma.dispute.findFirst({
      where: { orderId: order.id, status: { in: OPEN_DISPUTE_STATUSES } },
      select: { id: true },
    });
    if (openDispute) {
      this.logger.warn(
        `AUTO_CANCEL_UNSHIPPED SKIP order=${order.orderId}: dispute berjalan — tidak disentuh`,
      );
      return { orderId: order.orderId, outcome: 'SKIPPED_DISPUTED', detail: 'Dispute sedang berjalan' };
    }

    try {
      await this.orderStateService.adminCancelOrder(
        order.orderId,
        actorId,
        reason,
        OrderCancelReason.TIMEOUT_PROCESSING,
      );
    } catch (e) {
      if (e instanceof ConflictException || (e instanceof BadRequestException && this.isStatusRace(e))) {
        // Race: status berubah di tengah jalan (mis. dispute dibuka /
        // seller kirim). Baca ulang — bila sudah CANCELLED, refund ditangani
        // pemenang race; bila DISPUTED/IN_DELIVERY, lewati (fail closed).
        const fresh = await this.prisma.order.findUnique({
          where: { id: order.id },
          select: { status: true },
        });
        if (fresh?.status === OrderStatus.CANCELLED) {
          return { orderId: order.orderId, outcome: 'ALREADY_HANDLED', detail: 'Race: sudah CANCELLED' };
        }
        return {
          orderId: order.orderId,
          outcome: 'SKIPPED_NOT_DUE',
          detail: `Race: status berubah menjadi ${fresh?.status ?? 'unknown'} — tidak disentuh`,
        };
      }
      this.logger.error(
        `[SECURITY] AUTO_CANCEL_UNSHIPPED FAILED order=${order.orderId} buyer=${order.buyerId}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return {
        orderId: order.orderId,
        outcome: 'FAILED',
        detail: e instanceof Error ? e.message : String(e),
      };
    }

    this.logger.log(
      `[SECURITY] AUTO_CANCEL_UNSHIPPED order=${order.orderId} buyer=${order.buyerId} ` +
        `refundSen=${order.buyerPayAmount.toString()} reason="${reason}" actor=${actorId}`,
    );
    return { orderId: order.orderId, outcome: 'CANCELLED_REFUNDED' };
  }

  private isPastShipDeadline(
    processingDeadlineAt: Date | null,
    paidAt: Date | null,
    now: Date,
  ): boolean {
    if (processingDeadlineAt) return processingDeadlineAt.getTime() < now.getTime();
    // Backfill implisit order lama: paidAt + PROCESSING_DEADLINE_DAYS.
    if (paidAt) return paidAt.getTime() + UnshippedOrderCancelService.processingDeadlineMs() < now.getTime();
    return false;
  }

  private isStatusRace(e: BadRequestException): boolean {
    const msg = e.message.toLowerCase();
    return msg.includes('status') || msg.includes('cancel');
  }
}

/** Status dispute yang dianggap "berjalan" — semua kecuali RESOLVED. */
export const OPEN_DISPUTE_STATUSES: DisputeStatus[] = [
  DisputeStatus.OPEN,
  DisputeStatus.ASSIGNED,
  DisputeStatus.UNDER_REVIEW,
  DisputeStatus.WAITING_RESPONSE,
  DisputeStatus.ESCALATED,
];

export type UnshippedCancelOutcome =
  | 'CANCELLED_REFUNDED'
  | 'ALREADY_HANDLED'
  | 'SKIPPED_NOT_DUE'
  | 'SKIPPED_DISPUTED'
  | 'FAILED';

export interface UnshippedCancelResult {
  /** orderId publik (ORD-...). */
  orderId: string;
  outcome: UnshippedCancelOutcome;
  detail?: string;
}
