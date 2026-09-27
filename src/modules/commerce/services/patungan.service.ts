import { Injectable, NotFoundException, ForbiddenException, BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { PatunganStatus, PatunganMode, PatunganParticipantStatus, OrderStatus, Prisma } from '@prisma/client';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { toSen, toIdr } from '../../../common/utils/currency.util';
import { createPaginatedResponse, PaginatedResponse } from '../../../common/dto/pagination.dto';
import { OrderStateService } from '../../orders/order-state.service';
import { CreatePatunganGroupDto, JoinPatunganDto } from '../dto/commerce.dto';

/** Masa sanggah peserta setelah host inisiasi cair: 24 jam. */
export const PATUNGAN_CONTEST_HOURS = 24;

/**
 * BE-COMMERCE (2026-10-01) — item 14: patungan grup.
 *
 * TANPA LOGIKA UANG BARU. Modul ini hanya mencatat SYARAT pelepasan escrow:
 * - Setiap peserta bayar via escrow order NORMAL (existing flow), ditautkan
 *   lewat link-order (orderId).
 * - Target tercapai → host inisiasi cair → masa sanggah 24 jam (peserta bisa
 *   buka dispute via alur existing) → RELEASED = syarat pelepasan terpenuhi;
 *   pencairan dana aktual tetap lewat penyelesaian order escrow normal.
 * - Gagal (deadline lewat & target tak tercapai) → auto-refund SEJAUH
 *   dimungkinkan alur existing (cancel order yang masih cancellable; order
 *   yang sudah dibayar → REFUND_REQUIRED, fail closed).
 * - Overfunding → kelebihan dihitung sebagai pengurang merata per orang
 *   (informatif di response; bukan perubahan nilai order).
 */
@Injectable()
export class PatunganService {
  private readonly logger = new Logger(PatunganService.name);

  constructor(
    private prisma: PrismaService,
    private orderStateService: OrderStateService,
  ) {}

  private async assertHostGroup(hostId: string, groupId: string) {
    const group = await this.prisma.patunganGroup.findFirst({
      where: { id: groupId, hostId },
      include: { participants: true },
    });
    if (!group) throw new NotFoundException({ code: ErrorCodes.PATUNGAN_GROUP_NOT_FOUND, message: 'Grup patungan tidak ditemukan' });
    return group;
  }

  // ── Host ────────────────────────────────────────────────────────────────

  async createGroup(hostId: string, dto: CreatePatunganGroupDto) {
    const deadlineAt = new Date(dto.deadlineAt);
    if (Number.isNaN(deadlineAt.getTime()) || deadlineAt.getTime() <= Date.now()) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Deadline harus di masa depan' });
    }
    const mode = dto.mode ?? PatunganMode.BAGI_RATA;
    let perPersonAmount: bigint | null = null;
    if (mode === PatunganMode.BAGI_RATA) {
      if (dto.perPersonAmountIdr === undefined) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Mode bagi rata wajib mengisi perPersonAmountIdr' });
      }
      perPersonAmount = toSen(dto.perPersonAmountIdr);
      if (perPersonAmount <= 0n) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Nominal per orang harus > 0' });
      }
    }
    return this.prisma.patunganGroup.create({
      data: {
        hostId,
        title: dto.title.trim(),
        description: dto.description?.trim() || null,
        targetAmount: toSen(dto.targetAmountIdr),
        deadlineAt,
        slotTotal: dto.slotTotal ?? 0,
        mode,
        perPersonAmount,
        status: PatunganStatus.OPEN,
      },
    });
  }

  async listGroups(page = 1, limit = 20, status?: PatunganStatus): Promise<PaginatedResponse<Record<string, unknown>>> {
    const where: Prisma.PatunganGroupWhereInput = status ? { status } : {};
    const [rows, total] = await Promise.all([
      this.prisma.patunganGroup.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.patunganGroup.count({ where }),
    ]);
    const enriched = await Promise.all(rows.map((g) => this.withComputed(g)));
    return createPaginatedResponse(enriched, total, page, limit);
  }

  async getGroupDetail(groupId: string) {
    const group = await this.prisma.patunganGroup.findFirst({
      where: { id: groupId },
      include: {
        participants: {
          select: { id: true, userId: true, amount: true, orderId: true, paidAt: true, status: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!group) throw new NotFoundException({ code: ErrorCodes.PATUNGAN_GROUP_NOT_FOUND, message: 'Grup patungan tidak ditemukan' });
    return this.withComputed(group);
  }

  /** Hitung agregat transparan: total terkumpul, sisa, overfunding per orang. */
  private async withComputed(group: Record<string, any>) {
    const paid = (group.participants ?? []) as Array<{ amount: bigint; status: PatunganParticipantStatus }>;
    const paidParts = paid.filter((p) => p.status === PatunganParticipantStatus.PAID || p.status === PatunganParticipantStatus.RELEASED);
    const totalPaid = paidParts.reduce((a, p) => a + p.amount, 0n);
    const target = BigInt(group.targetAmount as bigint);
    const overfunding = totalPaid > target ? totalPaid - target : 0n;
    const overfundingPerPerson = paidParts.length > 0 ? overfunding / BigInt(paidParts.length) : 0n;
    return {
      ...group,
      targetAmountIdr: toIdr(target),
      totalPaidIdr: toIdr(totalPaid),
      remainingIdr: toIdr(totalPaid >= target ? 0n : target - totalPaid),
      participantCount: paid.length,
      paidCount: paidParts.length,
      slotsLeft: group.slotTotal > 0 ? Math.max(0, group.slotTotal - paid.length) : null,
      // Overfunding → pengurang merata per orang (informatif).
      overfundingIdr: toIdr(overfunding),
      overfundingPerPersonIdr: toIdr(overfundingPerPerson),
      // Fee dibagi rata & tampil upfront: mengikuti aturan fee escrow normal
      // per order peserta (tidak ada logika fee baru di sini).
      feeNote: 'Fee mengikuti aturan escrow normal per order peserta, dibagi rata secara natural karena tiap peserta bayar via order masing-masing.',
    };
  }

  // ── Peserta ─────────────────────────────────────────────────────────────

  async joinGroup(userId: string, groupId: string, dto: JoinPatunganDto) {
    const group = await this.prisma.patunganGroup.findFirst({ where: { id: groupId } });
    if (!group) throw new NotFoundException({ code: ErrorCodes.PATUNGAN_GROUP_NOT_FOUND, message: 'Grup patungan tidak ditemukan' });
    if (group.status !== PatunganStatus.OPEN) {
      throw new BadRequestException({ code: ErrorCodes.PATUNGAN_NOT_OPEN, message: 'Grup tidak sedang dibuka' });
    }
    if (group.deadlineAt.getTime() <= Date.now()) {
      throw new BadRequestException({ code: ErrorCodes.PATUNGAN_NOT_OPEN, message: 'Deadline patungan sudah lewat' });
    }
    if (group.hostId === userId) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Host otomatis peserta — tidak perlu join' });
    }
    let amount: bigint;
    if (group.mode === PatunganMode.BAGI_RATA) {
      amount = group.perPersonAmount!;
    } else {
      if (dto.amountIdr === undefined) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Mode custom wajib mengisi amountIdr' });
      }
      amount = toSen(dto.amountIdr);
      if (amount <= 0n || amount > group.targetAmount) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Nominal custom harus > 0 dan ≤ target' });
      }
    }
    try {
      const participant = await this.prisma.patunganParticipant.create({
        data: { groupId: group.id, userId, amount, orderId: dto.orderId ?? null, status: PatunganParticipantStatus.PENDING },
      });
      if (group.slotTotal > 0) {
        const count = await this.prisma.patunganParticipant.count({ where: { groupId: group.id } });
        if (count > group.slotTotal) {
          await this.prisma.patunganParticipant.delete({ where: { id: participant.id } });
          throw new ConflictException({ code: ErrorCodes.PATUNGAN_SLOT_FULL, message: 'Slot grup penuh' });
        }
      }
      return participant;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({ code: ErrorCodes.PATUNGAN_ALREADY_JOINED, message: 'Kamu sudah join grup ini' });
      }
      throw e;
    }
  }

  /**
   * Tautkan escrow order yang SUDAH DIBAYAR (dibuat via alur order normal).
   * Setelah ini, cek otomatis: total PAID >= target → TARGET_REACHED.
   */
  async linkOrder(userId: string, participantId: string, orderId: string) {
    const participant = await this.prisma.patunganParticipant.findFirst({
      where: { id: participantId, userId },
      include: { group: true },
    });
    if (!participant) throw new NotFoundException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Data peserta tidak ditemukan' });
    if (participant.status !== PatunganParticipantStatus.PENDING) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Peserta sudah dalam proses / selesai' });
    }
    if (participant.group.status !== PatunganStatus.OPEN) {
      throw new BadRequestException({ code: ErrorCodes.PATUNGAN_NOT_OPEN, message: 'Grup tidak sedang dibuka' });
    }
    const order = await this.prisma.order.findFirst({
      where: { OR: [{ id: orderId }, { orderId }], deletedAt: null },
      select: { id: true, buyerId: true, sellerId: true, orderValue: true, status: true },
    });
    if (!order || order.buyerId !== userId) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Order tidak valid / bukan milikmu' });
    }
    if (order.sellerId !== participant.group.hostId) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Seller order harus host grup patungan' });
    }
    if (order.orderValue !== participant.amount) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Nilai order harus sama persis dengan nominal patungan' });
    }
    if (![OrderStatus.PROCESSING, OrderStatus.IN_DELIVERY, OrderStatus.COMPLETED].includes(order.status)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Order belum dibayar' });
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const p = await tx.patunganParticipant.update({
        where: { id: participant.id },
        data: { orderId: order.id, paidAt: new Date(), status: PatunganParticipantStatus.PAID },
      });
      const agg = await tx.patunganParticipant.aggregate({
        where: { groupId: participant.groupId, status: PatunganParticipantStatus.PAID },
        _sum: { amount: true },
      });
      const totalPaid = agg._sum.amount ?? 0n;
      if (totalPaid >= participant.group.targetAmount && participant.group.status === PatunganStatus.OPEN) {
        await tx.patunganGroup.update({ where: { id: participant.groupId }, data: { status: PatunganStatus.TARGET_REACHED } });
      }
      return p;
    });
    return updated;
  }

  /**
   * Host inisiasi pencairan → masa sanggah 24 jam (CONTEST). Selama masa
   * sanggah, peserta yang keberatan membuka dispute via alur existing.
   */
  async initiateRelease(hostId: string, groupId: string) {
    const group = await this.assertHostGroup(hostId, groupId);
    if (group.status !== PatunganStatus.TARGET_REACHED) {
      throw new BadRequestException({ code: ErrorCodes.PATUNGAN_TARGET_NOT_REACHED, message: 'Target belum tercapai' });
    }
    const contestEndsAt = new Date(Date.now() + PATUNGAN_CONTEST_HOURS * 60 * 60 * 1000);
    return this.prisma.patunganGroup.update({
      where: { id: group.id },
      data: { status: PatunganStatus.CONTEST, contestEndsAt },
    });
  }

  // ── Cron ────────────────────────────────────────────────────────────────

  /**
   * Dipanggil cron tiap beberapa menit:
   * - Grup OPEN yang deadline lewat & target tak tercapai → FAILED + refund
   *   otomatis sejauh alur existing memungkinkan (cancel order cancellable;
   *   order berbayar → REFUND_REQUIRED, fail closed).
   * - Grup CONTEST yang masa sanggah habis → RELEASED (syarat pelepasan
   *   terpenuhi; dana cair lewat penyelesaian order escrow normal).
   */
  async processDeadlines(): Promise<{ failed: number; released: number }> {
    const now = new Date();
    let failed = 0;
    let released = 0;

    const expiredOpen = await this.prisma.patunganGroup.findMany({
      where: { status: PatunganStatus.OPEN, deadlineAt: { lt: now } },
      include: { participants: true },
    });
    for (const group of expiredOpen) {
      const totalPaid = group.participants
        .filter((p) => p.status === PatunganParticipantStatus.PAID)
        .reduce((a, p) => a + p.amount, 0n);
      if (totalPaid >= group.targetAmount) {
        await this.prisma.patunganGroup.update({ where: { id: group.id }, data: { status: PatunganStatus.TARGET_REACHED } });
        continue;
      }
      await this.prisma.patunganGroup.update({ where: { id: group.id }, data: { status: PatunganStatus.FAILED } });
      await this.refundParticipants(group.participants, group.hostId);
      failed++;
    }

    const contestDone = await this.prisma.patunganGroup.findMany({
      where: { status: PatunganStatus.CONTEST, contestEndsAt: { lt: now } },
      select: { id: true },
    });
    for (const group of contestDone) {
      await this.prisma.$transaction(async (tx) => {
        await tx.patunganGroup.update({ where: { id: group.id }, data: { status: PatunganStatus.RELEASED, releasedAt: new Date() } });
        await tx.patunganParticipant.updateMany({
          where: { groupId: group.id, status: PatunganParticipantStatus.PAID },
          data: { status: PatunganParticipantStatus.RELEASED },
        });
      });
      released++;
    }
    return { failed, released };
  }

  private async refundParticipants(
    participants: Array<{ id: string; orderId: string | null; status: PatunganParticipantStatus }>,
    hostId: string,
  ): Promise<void> {
    for (const p of participants) {
      if (p.status !== PatunganParticipantStatus.PAID || !p.orderId) {
        if (p.status === PatunganParticipantStatus.PENDING) {
          await this.prisma.patunganParticipant.update({ where: { id: p.id }, data: { status: PatunganParticipantStatus.REFUNDED } });
        }
        continue;
      }
      const order = await this.prisma.order.findUnique({ where: { id: p.orderId }, select: { orderId: true, status: true } });
      let refunded = false;
      if (order && [OrderStatus.WAITING_CONFIRMATION, OrderStatus.WAITING_PAYMENT].includes(order.status)) {
        try {
          await this.orderStateService.cancelOrder(order.orderId, hostId, 'OTHER', 'Patungan gagal: target tidak tercapai — auto-refund');
          refunded = true;
        } catch (e) {
          this.logger.warn(`Cancel order patungan gagal participant=${p.id}: ${(e as Error).message}`);
        }
      }
      await this.prisma.patunganParticipant.update({
        where: { id: p.id },
        data: { status: refunded ? PatunganParticipantStatus.REFUNDED : PatunganParticipantStatus.REFUND_REQUIRED },
      });
    }
  }
}
