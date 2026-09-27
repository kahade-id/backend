// GAP-C (G176–G200): layanan admin untuk milestone — daftar/filter,
// rekonsiliasi invariant, dan ringkasan escrow tertahan.
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { MilestoneStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { MilestonesService } from '../../milestones/milestones.service';
import { toIdr } from '../../../common/utils/currency.util';

export class AdminMilestoneQueryDto {
  status?: MilestoneStatus;
  orderId?: string;
  page?: number;
  limit?: number;
}

@Injectable()
export class AdminMilestonesService {
  private readonly logger = new Logger(AdminMilestonesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly milestones: MilestonesService,
  ) {}

  /** Daftar milestone lintas order dengan filter status (G196). */
  async listMilestones(query: AdminMilestoneQueryDto) {
    const page = Math.min(100, Math.max(1, Math.trunc(query.page ?? 1)));
    const limit = Math.min(100, Math.max(1, Math.trunc(query.limit ?? 20)));
    const where: Prisma.OrderMilestoneWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.orderId) {
      where.order = { orderId: query.orderId };
    }
    const [total, rows] = await Promise.all([
      this.prisma.orderMilestone.count({ where }),
      this.prisma.orderMilestone.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          seq: true,
          title: true,
          amount: true,
          sellerAmount: true,
          buyerAmount: true,
          feeAmount: true,
          status: true,
          deadline: true,
          reviewDeadline: true,
          submittedAt: true,
          acceptedAt: true,
          releasedAt: true,
          releasedTxId: true,
          revisionRounds: true,
          escrowHeld: true,
          // ADM-124: createdAt wajib di tipe admin MilestoneAdminItem —
          // sertakan agar kontrak tidak berbohong.
          createdAt: true,
          updatedAt: true,
          order: { select: { orderId: true, title: true, buyerId: true, sellerId: true, status: true } },
        },
      }),
    ]);
    const toNum = (v: bigint) => toIdr(v); // kontrak admin: nominal dalam IDR
    return {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      milestones: rows.map((m) => ({
        ...m,
        amount: toNum(m.amount),
        sellerAmount: toNum(m.sellerAmount),
        buyerAmount: toNum(m.buyerAmount),
        feeAmount: toNum(m.feeAmount),
        escrowHeld: toNum(m.escrowHeld),
      })),
    };
  }

  /** Ringkasan escrow milestone: total tertahan & total released (G186). */
  async escrowSummary() {
    const agg = await this.prisma.orderMilestone.aggregate({
      _sum: { escrowHeld: true, sellerAmount: true },
      _count: { _all: true },
      where: { status: { not: MilestoneStatus.CANCELLED } },
    });
    const released = await this.prisma.orderMilestone.aggregate({
      _sum: { sellerAmount: true },
      _count: { _all: true },
      where: { status: MilestoneStatus.RELEASED },
    });
    const byStatus = await this.prisma.orderMilestone.groupBy({
      by: ['status'],
      _count: { _all: true },
      _sum: { escrowHeld: true },
    });
    return {
      totalMilestones: agg._count._all,
      totalEscrowHeld: toIdr(agg._sum.escrowHeld ?? 0n),
      releasedCount: released._count._all,
      totalReleasedSellerAmount: toIdr(released._sum.sellerAmount ?? 0n),
      byStatus: byStatus.map((b) => ({
        status: b.status,
        count: b._count._all,
        escrowHeld: toIdr(b._sum.escrowHeld ?? 0n),
      })),
    };
  }

  /** Rekonsiliasi invariant satu order (G199). */
  async reconcileOrder(orderDbId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderDbId },
      select: { id: true },
    });
    if (!order) {
      throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Order tidak ditemukan.' });
    }
    return this.milestones.reconcileOrder(orderDbId);
  }

  /**
   * Rekonsiliasi massal: pindai order bermilestone yang berubah 24 jam
   * terakhir, kembalikan yang invariant-nya rusak (G199).
   */
  async reconcileRecent(limit = 100) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const orders = await this.prisma.order.findMany({
      where: { milestones: { some: { updatedAt: { gte: since } } } },
      select: { id: true, orderId: true },
      take: Math.min(500, Math.max(1, limit)),
      orderBy: { updatedAt: 'desc' },
    });
    const violations: { orderId: string; checks: unknown }[] = [];
    for (const o of orders) {
      const r = await this.milestones.reconcileOrder(o.id);
      if (r.hasMilestones && !r.ok) {
        violations.push({ orderId: r.orderId, checks: r.checks });
      }
    }
    return { scanned: orders.length, violations };
  }
}
