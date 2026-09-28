import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { MilestonesService } from '../../milestones/milestones.service';
import { CreateInstallmentPlanDto } from '../dto/commerce.dto';

/**
 * BE-COMMERCE (2026-10-01) — item 3: skema DP persen + jadwal cicilan otomatis.
 * Memakai modul milestone yang sudah ada (opt-in; keputusan user sudah setuju).
 * TIDAK ada logika uang baru — hanya menyusun CreateMilestonesDto lalu
 * mendelegasikan ke MilestonesService.createMilestones (validasi & split dana
 * tetap milik modul milestone).
 */
@Injectable()
export class InstallmentsService {
  constructor(
    private prisma: PrismaService,
    private milestonesService: MilestonesService,
  ) {}

  /**
   * POST /v1/commerce/installments/orders/:orderId/plan — hanya SELLER.
   * Menghasilkan 1 tahap DP + N tahap cicilan (atau N cicilan bila DP 0%).
   */
  async createInstallmentPlan(sellerId: string, orderId: string, dto: CreateInstallmentPlanDto) {
    if (dto.agreed !== true) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Skema cicilan bersifat opt-in: kedua pihak harus menyetujui (agreed=true)',
      });
    }
    const order = await this.prisma.order.findFirst({
      where: { OR: [{ id: orderId }, { orderId }], deletedAt: null },
      select: { id: true, orderId: true, sellerId: true, buyerId: true, orderValue: true, title: true },
    });
    if (!order) throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order tidak ditemukan' });
    if (order.sellerId !== sellerId) {
      throw new BadRequestException({ code: ErrorCodes.FORBIDDEN, message: 'Hanya seller order ini yang bisa membuat skema cicilan' });
    }
    if (order.orderValue % 100n !== 0n) {
      throw new BadRequestException({
        code: ErrorCodes.INSTALLMENT_INVALID_ORDER,
        message: 'Nilai order tidak bulat dalam rupiah — skema cicilan tidak bisa disusun',
      });
    }

    const totalIdr = Number(order.orderValue / 100n);
    const stages = this.buildStages(totalIdr, dto.dpPercent, dto.installmentCount);
    if (stages.length < 2) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Skema cicilan butuh minimal 2 tahap (naikkan jumlah cicilan atau tambah DP)',
      });
    }

    const intervalDays = dto.intervalDays ?? 30;
    const now = Date.now();
    const milestones = stages.map((s, i) => ({
      title: s.label,
      description: `Skema cicilan opt-in untuk order ${order.orderId} (DP ${dto.dpPercent}%, ${dto.installmentCount}x cicilan).`,
      amountIdr: s.amountIdr,
      deadline: new Date(now + (i + 1) * intervalDays * 24 * 60 * 60 * 1000).toISOString(),
      maxRevisionRounds: 0,
    }));

    return this.milestonesService.createMilestones(order.id, sellerId, { milestones });
  }

  /** Susun tahap: [DP?, cicilan...] dengan total TEPAT = totalIdr. */
  private buildStages(totalIdr: number, dpPercent: number, installmentCount: number): { label: string; amountIdr: number }[] {
    const stages: { label: string; amountIdr: number }[] = [];
    let remaining = totalIdr;
    if (dpPercent > 0) {
      const dpIdr = Math.round((totalIdr * dpPercent) / 100);
      stages.push({ label: `DP ${dpPercent}%`, amountIdr: dpIdr });
      remaining -= dpIdr;
    }
    const base = Math.floor(remaining / installmentCount);
    for (let i = 1; i <= installmentCount; i++) {
      const isLast = i === installmentCount;
      stages.push({
        label: `Cicilan ${i}/${installmentCount}`,
        amountIdr: isLast ? remaining - base * (installmentCount - 1) : base,
      });
    }
    return stages.filter((s) => s.amountIdr > 0);
  }
}
