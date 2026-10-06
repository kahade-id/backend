import { Injectable, NotFoundException, ForbiddenException, BadRequestException, ConflictException, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { PatunganStatus, PatunganMode, PatunganParticipantStatus, OrderStatus, DisputeStatus, OrderType, OrderKind, FeeResponsibility, Prisma } from '@prisma/client';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { toSen, toIdr } from '../../../common/utils/currency.util';
import { createPaginatedResponse, PaginatedResponse } from '../../../common/dto/pagination.dto';
import { OrderStateService } from '../../orders/order-state.service';
import { OrdersService } from '../../orders/orders.service';
import { CommerceOrderHooks } from '../commerce-order-hooks';
import { clampDeadlineDays } from '../commerce-order.util';
import { CreatePatunganGroupDto, JoinPatunganDto } from '../dto/commerce.dto';

/** Union penuh agar `.includes(status)` menerima semua nilai enum. */
const PAID_ORDER_STATUSES: OrderStatus[] = [OrderStatus.PROCESSING, OrderStatus.IN_DELIVERY, OrderStatus.COMPLETED];

/** Masa sanggah peserta setelah host inisiasi cair: 24 jam. */
export const PATUNGAN_CONTEST_HOURS = 24;

/**
 * BE-COMMERCE (2026-10-01) — item 14: patungan grup.
 *
 * TANPA LOGIKA UANG BARU. Modul ini hanya mencatat SYARAT pelepasan escrow:
 * - Setiap peserta bayar via escrow order NORMAL (existing flow), ditautkan
 *   lewat create-order/link-order (orderId).
 * - Target tercapai → host inisiasi cair → masa sanggah 24 jam (peserta bisa
 *   buka dispute via alur existing) → RELEASED = syarat pelepasan terpenuhi;
 *   pencairan dana aktual tetap lewat penyelesaian order escrow normal.
 * - Gagal (deadline lewat & target tak tercapai) → auto-refund SEJAUH
 *   dimungkinkan alur existing (cancel order yang masih cancellable; order
 *   yang sudah dibayar → REFUND_REQUIRED, fail closed).
 * - Overfunding → kelebihan dihitung sebagai pengurang merata per orang
 *   (informatif di response; bukan perubahan nilai order).
 *
 * POIN 2 (2026-10-04) — mekanisme khusus → standar (BUKAN jalur paralel):
 * - "Masa sanggah 24 jam" = ATURAN OTOMATIS sebagai trigger dalam alur
 *   sengketa STANDAR: selama CONTEST, peserta yang keberatan membuka sengketa
 *   lewat DisputesService.submitDispute (kategori SERVICE_NOT_RENDERED bila
 *   jasa/barang tidak diberikan — sudah cukup, tanpa kategori baru);
 *   processDeadlines MENAHAN rilis (fail closed, perpanjang 24 jam) selama
 *   ada sengketa terbuka. Tidak ada mesin sengketa khusus patungan.
 * - "Refund otomatis" = trigger dalam alur refund STANDAR:
 *   OrderStateService.cancelOrder / adminCancelOrder (via CommerceRefundService
 *   untuk REFUND_REQUIRED). Tidak ada logika pergerakan dana baru di sini.
 */
@Injectable()
export class PatunganService implements OnModuleInit {
  private readonly logger = new Logger(PatunganService.name);

  constructor(
    private prisma: PrismaService,
    private orderStateService: OrderStateService,
    // POIN 2 (2026-10-04): create-order dari peserta memanggil
    // OrdersService.createOrder secara internal. Satu arah (commerce →
    // orders); tanpa circular DI.
    private ordersService: OrdersService,
  ) {}

  onModuleInit(): void {
    // POIN 2: peserta yang order-nya dibuat via create-order (belum bayar)
    // ditandai PAID saat pembayaran terkonfirmasi — via registry statis
    // CommerceOrderHooks (pola ChatOrderHooks), bukan DI.
    CommerceOrderHooks.onOrderPaid((orderPublicId) => this.markParticipantPaidByOrder(orderPublicId));
  }

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
    // P2-6: tolak grup dengan target yang mustahil tercapai (jebakan
    // likuiditas — dana peserta terkunci sampai deadline tanpa kemungkinan
    // sukses). Aturan: slotTotal 0 = tanpa batas (tidak dicek); selain itu
    // minimal 2 (spek 2–100); mode BAGI_RATA wajib memenuhi
    // perPersonAmount × slotTotal ≥ targetAmount.
    const targetAmount = toSen(dto.targetAmountIdr);
    const slotTotal = dto.slotTotal ?? 0;
    if (slotTotal === 1) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'slotTotal minimal 2 (atau 0 = tanpa batas slot)' });
    }
    if (mode === PatunganMode.BAGI_RATA && slotTotal > 0 && perPersonAmount! * BigInt(slotTotal) < targetAmount) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Target tidak mungkin tercapai: perPersonAmount × slotTotal lebih kecil dari targetAmount',
      });
    }
    return this.prisma.patunganGroup.create({
      data: {
        hostId,
        title: dto.title.trim(),
        description: dto.description?.trim() || null,
        targetAmount,
        deadlineAt,
        slotTotal,
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

  // ── Admin (monitoring saja, tanpa aksi finansial) ───────────────────────

  /** Nama display user untuk field hostName/userName di response admin. */
  private async userDisplayNames(userIds: string[]): Promise<Map<string, string | null>> {
    const uniq = [...new Set(userIds.filter((id) => !!id))];
    if (uniq.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: uniq } },
      select: { id: true, fullName: true },
    });
    return new Map(users.map((u) => [u.id, u.fullName]));
  }

  /** Daftar grup patungan untuk admin: filter status + pencarian judul/hostId. */
  async listAdminGroups(page = 1, limit = 20, status?: PatunganStatus, q?: string) {
    const where: Prisma.PatunganGroupWhereInput = {};
    if (status && Object.values(PatunganStatus).includes(status)) where.status = status;
    const keyword = q?.trim();
    if (keyword) {
      where.OR = [
        { title: { contains: keyword, mode: 'insensitive' } },
        { hostId: { contains: keyword } },
      ];
    }
    const [rows, total] = await Promise.all([
      this.prisma.patunganGroup.findMany({
        where,
        include: { participants: { select: { status: true, amount: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.patunganGroup.count({ where }),
    ]);
    const names = await this.userDisplayNames(rows.map((g) => g.hostId));
    const items = await Promise.all(
      rows.map(async (g) =>
        this.toAdminItem(await this.withComputed(g as Record<string, any>), names.get(g.hostId) ?? null, g.slotTotal),
      ),
    );
    return createPaginatedResponse(items, total, page, limit);
  }

  /** Detail grup patungan untuk admin: agregat transparan + daftar peserta. */
  async getAdminGroupDetail(groupId: string) {
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
    const enriched = (await this.withComputed(group as Record<string, any>)) as Record<string, any>;
    const names = await this.userDisplayNames([
      group.hostId,
      ...group.participants.map((p) => p.userId),
    ]);
    return {
      ...this.toAdminItem(enriched, names.get(group.hostId) ?? null, group.slotTotal),
      splitMode: enriched.mode,
      disbursedAmount: null,
      participants: group.participants.map((p) => ({
        userId: p.userId,
        userName: names.get(p.userId) ?? null,
        amount: toIdr(p.amount),
        hasPaid:
          p.status === PatunganParticipantStatus.PAID ||
          p.status === PatunganParticipantStatus.RELEASED ||
          p.paidAt !== null,
        joinedAt: p.createdAt,
        paidAt: p.paidAt,
      })),
    };
  }

  private toAdminItem(enriched: Record<string, any>, hostName: string | null, slotTotal: number) {
    return {
      id: enriched.id,
      title: enriched.title,
      hostId: enriched.hostId,
      hostName,
      targetAmount: enriched.targetAmountIdr,
      collectedAmount: enriched.totalPaidIdr,
      participantCount: enriched.participantCount,
      maxParticipants: slotTotal > 0 ? slotTotal : null,
      status: enriched.status,
      deadline: enriched.deadlineAt,
      createdAt: enriched.createdAt,
      updatedAt: enriched.updatedAt,
    };
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
    // LOW #1 (SEC-B ronde 2): orderId TIDAK ADA di JoinPatunganDto — penautan
    // order WAJIB lewat linkOrder yang memvalidasi kepemilikan, seller, nilai,
    // dan status. Menerima orderId mentah di join membuka squatting
    // (mengklaim order milik orang lain).
    return this.prisma.$transaction(async (tx) => {
      const group = await tx.patunganGroup.findFirst({ where: { id: groupId } });
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
      if (group.slotTotal > 0) {
        // Wave 2 (LOW slot race): kunci baris grup secara EKSPLISIT via
        // SELECT ... FOR UPDATE — pola yang sama dipakai di dispute
        // resolution & Wave 1 (conditional update / row lock). Update kosong
        // (`data: {}`) tidak dijamin menerbitkan UPDATE oleh Prisma sehingga
        // tidak bisa diandalkan sebagai row lock; tanpa lock yang nyata, dua
        // join konkuren bisa sama-sama lolos hitungan slot (peserta terhitung
        // ganda / over-capacity).
        await tx.$queryRaw`SELECT id FROM patungan_groups WHERE id = ${group.id} FOR UPDATE`;
        const count = await tx.patunganParticipant.count({ where: { groupId: group.id } });
        if (count >= group.slotTotal) {
          throw new ConflictException({ code: ErrorCodes.PATUNGAN_SLOT_FULL, message: 'Slot grup penuh' });
        }
      }
      try {
        return await tx.patunganParticipant.create({
          data: { groupId: group.id, userId, amount, orderId: null, status: PatunganParticipantStatus.PENDING },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          throw new ConflictException({ code: ErrorCodes.PATUNGAN_ALREADY_JOINED, message: 'Kamu sudah join grup ini' });
        }
        throw e;
      }
    });
  }

  /**
   * POIN 2 (2026-10-04) — unifikasi transaksi escrow: peserta membuat escrow
   * order LANGSUNG (menggantikan pola lama "buat order manual lalu tempel ID
   * via link-order").
   *
   * - Order dibuat via `OrdersService.createOrder` (internal) dengan
   *   `orderKind=PATUNGAN`; fee/voucher/notifikasi mengikuti alur normal.
   * - `participant.orderId` terisi otomatis dalam SATU transaksi DB (advisory
   *   lock per peserta + predicate status).
   * - Order berawal BELUM dibayar; peserta tetap PENDING sampai pembayaran
   *   terkonfirmasi → PAID via CommerceOrderHooks / syncPaidParticipants,
   *   lalu cek target tercapai (checkAndMarkTargetReached).
   *
   * Catatan transaksi: sama seperti jastip — createOrder punya tx sendiri;
   * urutan: kunci advisory → verifikasi ulang → buat order → tautkan.
   */
  async createOrderFromParticipant(userId: string, participantId: string) {
    const participant = await this.prisma.patunganParticipant.findFirst({
      where: { id: participantId, userId },
      include: { group: { select: { id: true, hostId: true, status: true, title: true, deadlineAt: true } } },
    });
    if (!participant) {
      throw new NotFoundException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Data peserta tidak ditemukan' });
    }
    if (participant.orderId) {
      throw new ConflictException({ code: ErrorCodes.ORDER_ALREADY_LINKED, message: 'Order sudah dibuat untuk peserta ini' });
    }
    if (participant.status !== PatunganParticipantStatus.PENDING) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Peserta sudah dalam proses / selesai' });
    }
    if (participant.group.status !== PatunganStatus.OPEN) {
      throw new BadRequestException({ code: ErrorCodes.PATUNGAN_NOT_OPEN, message: 'Grup tidak sedang dibuka' });
    }
    if (participant.amount <= 0n) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Nominal patungan tidak valid' });
    }
    const host = await this.prisma.user.findUnique({
      where: { id: participant.group.hostId },
      select: { username: true },
    });
    if (!host?.username) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Host grup tidak valid' });
    }

    const orderValueIdr = toIdr(participant.amount);
    const title = `Patungan: ${participant.group.title}`.replace(/[<>"'&]/g, '').trim().slice(0, 100);
    const description = `Kontribusi patungan "${participant.group.title}" — nominal Rp${orderValueIdr}.`
      .replace(/[<>"'&]/g, '')
      .trim()
      .slice(0, 500);
    const deliveryDeadlineDays = clampDeadlineDays(participant.group.deadlineAt);

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, `commerce_create_order:${participant.id}`);
      const fresh = await tx.patunganParticipant.findUnique({
        where: { id: participant.id },
        select: { status: true, orderId: true },
      });
      if (!fresh) {
        throw new NotFoundException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Data peserta tidak ditemukan' });
      }
      if (fresh.orderId) {
        throw new ConflictException({ code: ErrorCodes.ORDER_ALREADY_LINKED, message: 'Order sudah dibuat untuk peserta ini' });
      }
      if (fresh.status !== PatunganParticipantStatus.PENDING) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Peserta sudah dalam proses / selesai' });
      }
      const created = await this.ordersService.createOrder(userId, {
        role: 'BUYER',
        counterpartUsername: host.username as string,
        title,
        description,
        orderType: OrderType.PHYSICAL_GOODS,
        orderKind: OrderKind.PATUNGAN,
        orderValue: orderValueIdr,
        deliveryDeadlineDays,
        feeResponsibility: FeeResponsibility.BUYER,
      });
      const orderRow = await tx.order.findUnique({ where: { orderId: created.orderId }, select: { id: true } });
      if (!orderRow) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Order gagal dibuat' });
      }
      const marked = await tx.patunganParticipant.updateMany({
        where: { id: participant.id, status: PatunganParticipantStatus.PENDING, orderId: null },
        data: { orderId: orderRow.id },
      });
      if (marked.count === 0) {
        // P2-1: attach gagal setelah order ter-commit → order yatim.
        // Best-effort cleanup (order baru WAITING_* → cancellable buyer).
        await this.cancelOrphanOrder(userId, created.orderId);
        throw new ConflictException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Peserta sudah dalam proses' });
      }
      return {
        participantId: participant.id,
        orderId: created.orderId,
        orderKind: OrderKind.PATUNGAN,
        status: created.status,
        buyerPayAmount: created.feeCalculation.buyerPayAmount,
        confirmationDeadlineAt: created.confirmationDeadlineAt,
      };
    });
  }

  /**
   * P2-1: best-effort cleanup order yatim — order ter-commit tetapi gagal
   * ditautkan ke peserta. Tidak pernah throw.
   */
  private async cancelOrphanOrder(buyerId: string, orderPublicId: string): Promise<void> {
    try {
      await this.orderStateService.cancelOrder(orderPublicId, buyerId, 'OTHER', 'Cleanup P2-1: order yatim gagal ditautkan ke peserta patungan');
    } catch (e) {
      this.logger.warn(`[P2-1] Gagal cleanup order yatim ${orderPublicId}: ${(e as Error).message}`);
    }
  }

  /**
   * Peserta PENDING yang order-nya (dibuat via create-order) sudah berstatus
   * bayar → PAID + cek target tercapai. Dipanggil real-time via
   * CommerceOrderHooks dan fallback via syncPaidParticipants (cron).
   * Idempoten: predicate status.
   */
  async markParticipantPaidByOrder(orderPublicId: string): Promise<void> {
    const order = await this.prisma.order.findFirst({
      where: { orderId: orderPublicId, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!order || !PAID_ORDER_STATUSES.includes(order.status)) return;
    const marked = await this.prisma.patunganParticipant.updateMany({
      where: { orderId: order.id, status: PatunganParticipantStatus.PENDING },
      data: { status: PatunganParticipantStatus.PAID, paidAt: new Date() },
    });
    if (marked.count === 0) return;
    const participant = await this.prisma.patunganParticipant.findFirst({
      where: { orderId: order.id },
      select: { id: true, groupId: true },
    });
    if (!participant) return;
    // P2-5: balapan dengan processDeadlines — pembayaran masuk TEPAT SETELAH
    // cron mengklaim grup OPEN → FAILED. Peserta tidak boleh tertinggal PAID
    // di grup FAILED tanpa refund (sweep berikutnya hanya memproses grup
    // OPEN). Tandai REFUND_REQUIRED agar dieksekusi auto-refund (fail closed).
    const group = await this.prisma.patunganGroup.findUnique({
      where: { id: participant.groupId },
      select: { status: true },
    });
    if (group?.status === PatunganStatus.FAILED) {
      const flagged = await this.prisma.patunganParticipant.updateMany({
        where: { id: participant.id, status: PatunganParticipantStatus.PAID },
        data: { status: PatunganParticipantStatus.REFUND_REQUIRED },
      });
      if (flagged.count > 0) {
        this.logger.warn(`[P2-5] Peserta ${participant.id} PAID setelah grup ${participant.groupId} FAILED — ditandai REFUND_REQUIRED`);
      }
      return;
    }
    await this.checkAndMarkTargetReached(participant.groupId);
  }

  /**
   * Cek agregat PAID vs target → TARGET_REACHED (kondisional, predicate
   * status). Dipakai alur baru (paid-flip) dan fallback cron. Balapan dengan
   * processDeadlines (grup sudah FAILED) → return false, tanpa menimpa.
   */
  private async checkAndMarkTargetReached(groupId: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const freshGroup = await tx.patunganGroup.findUnique({
        where: { id: groupId },
        select: { status: true, targetAmount: true },
      });
      if (!freshGroup || freshGroup.status !== PatunganStatus.OPEN) return false;
      const agg = await tx.patunganParticipant.aggregate({
        where: { groupId, status: PatunganParticipantStatus.PAID },
        _sum: { amount: true },
      });
      const totalPaid = agg._sum.amount ?? 0n;
      if (totalPaid < freshGroup.targetAmount) return false;
      const claimed = await tx.patunganGroup.updateMany({
        where: { id: groupId, status: PatunganStatus.OPEN },
        data: { status: PatunganStatus.TARGET_REACHED },
      });
      return claimed.count > 0;
    });
  }

  /**
   * Fallback cron (CommerceSchedulerService, tiap 5 menit): sinkronkan
   * peserta PENDING + orderId yang order-nya sudah bayar → PAID + cek target.
   * Mengembalikan jumlah peserta yang disinkronkan.
   */
  async syncPaidParticipants(): Promise<number> {
    const candidates = await this.prisma.patunganParticipant.findMany({
      where: { status: PatunganParticipantStatus.PENDING, orderId: { not: null } },
      select: { orderId: true },
      take: 500,
    });
    const orderIds = [...new Set(candidates.map((c) => c.orderId as string))];
    if (orderIds.length === 0) return 0;
    const paidOrders = await this.prisma.order.findMany({
      where: { id: { in: orderIds }, status: { in: PAID_ORDER_STATUSES } },
      select: { id: true },
    });
    if (paidOrders.length === 0) return 0;
    const paidIds = paidOrders.map((o) => o.id);
    const flipped = await this.prisma.patunganParticipant.updateMany({
      where: { orderId: { in: paidIds }, status: PatunganParticipantStatus.PENDING },
      data: { status: PatunganParticipantStatus.PAID, paidAt: new Date() },
    });
    if (flipped.count > 0) {
      const groups = await this.prisma.patunganParticipant.findMany({
        where: { orderId: { in: paidIds } },
        select: { groupId: true },
        distinct: ['groupId'],
      });
      for (const g of groups) await this.checkAndMarkTargetReached(g.groupId);
    }
    return flipped.count;
  }

  /**
   * Tautkan escrow order yang SUDAH DIBAYAR (dibuat via alur order normal).
   * Setelah ini, cek otomatis: total PAID >= target → TARGET_REACHED.
   *
   * @deprecated POIN 2 (2026-10-04): pola "tempel ID manual" digantikan
   * `POST /v1/patungan/participants/:id/create-order`
   * (`createOrderFromParticipant`) — order dibuat internal + orderId terisi
   * otomatis. Endpoint ini dipertahankan non-breaking untuk klien lama.
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
    if (!PAID_ORDER_STATUSES.includes(order.status)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Order belum dibayar' });
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      // LOW #2 (SEC-B ronde 2): kunci advisory per order agar linkOrder
      // patungan vs jastip untuk order yang SAMA terserialisasi — menutup
      // race double-link lintas tabel yang tak bisa dijangkau unique
      // constraint per tabel. Lock dilepas otomatis saat tx selesai.
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, `commerce_link_order:${order.id}`);
      // Satu order berbayar TIDAK BOLEH ditautkan ke 2 peserta (cegah
      // TARGET_REACHED palsu lewat double-counting dana escrow yang sama) —
      // cek di DALAM tx: peserta patungan lain + peserta jastip.
      const [alreadyLinked, linkedJastip] = await Promise.all([
        tx.patunganParticipant.findFirst({
          where: { orderId: order.id, id: { not: participant.id } },
          select: { id: true },
        }),
        tx.jastipParticipant.findFirst({ where: { orderId: order.id }, select: { id: true } }),
      ]);
      if (alreadyLinked || linkedJastip) {
        throw new BadRequestException({
          code: ErrorCodes.ORDER_ALREADY_LINKED,
          message: 'Order ini sudah ditautkan ke peserta lain',
        });
      }
      // M4: peserta hanya boleh transisi PENDING → PAID (predicate status).
      // Dua linkOrder konkuren untuk peserta yang sama: satu menang, satu
      // mendapat count=0 → BadRequest, bukan double-link.
      const marked = await tx.patunganParticipant.updateMany({
        where: { id: participant.id, status: PatunganParticipantStatus.PENDING },
        data: { orderId: order.id, paidAt: new Date(), status: PatunganParticipantStatus.PAID },
      });
      if (marked.count === 0) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Peserta sudah dalam proses / selesai' });
      }
      // M4: baca ulang grup DI DALAM tx — snapshot di luar tx bisa basi
      // (balapan dengan processDeadlines).
      const freshGroup = await tx.patunganGroup.findUnique({
        where: { id: participant.groupId },
        select: { status: true, targetAmount: true },
      });
      if (!freshGroup || freshGroup.status !== PatunganStatus.OPEN) {
        throw new BadRequestException({ code: ErrorCodes.PATUNGAN_NOT_OPEN, message: 'Grup tidak sedang dibuka' });
      }
      const agg = await tx.patunganParticipant.aggregate({
        where: { groupId: participant.groupId, status: PatunganParticipantStatus.PAID },
        _sum: { amount: true },
      });
      const totalPaid = agg._sum.amount ?? 0n;
      if (totalPaid >= freshGroup.targetAmount) {
        // M4: transisi OPEN → TARGET_REACHED kondisional. Bila kalah balapan
        // dengan processDeadlines (grup sudah FAILED), lempar agar SELURUH
        // tx rollback — peserta tidak boleh tertinggal PAID di grup FAILED
        // tanpa refund; refund ditangani sisi deadline.
        const claimed = await tx.patunganGroup.updateMany({
          where: { id: participant.groupId, status: PatunganStatus.OPEN },
          data: { status: PatunganStatus.TARGET_REACHED },
        });
        if (claimed.count === 0) {
          throw new ConflictException({ code: ErrorCodes.PATUNGAN_NOT_OPEN, message: 'Grup berubah status saat pembayaran diproses' });
        }
      }
      return tx.patunganParticipant.findUnique({ where: { id: participant.id } });
    }).catch((e) => {
      // Race antar-request: unique constraint DB (orderId) menolak link ganda
      // → sampaikan sebagai BadRequest yang sama, bukan error mentah.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException({
          code: ErrorCodes.ORDER_ALREADY_LINKED,
          message: 'Order ini sudah ditautkan ke peserta patungan lain',
        });
      }
      throw e;
    });
    return updated;
  }

  /**
   * Keluar dari grup patungan (LOW #1 SEC-B ronde 2: endpoint leave).
   *
   * Hanya peserta PENDING (belum menautkan order berbayar) yang bisa keluar —
   * belum ada dana bergerak sehingga aman tanpa refund. Peserta PAID+ WAJIB
   * lewat alur order normal (cancel/refund/dispute); keluar diam-diam akan
   * memutus rantai akuntabilitas dana escrow. Grup yang sudah RELEASED tidak
   * bisa ditinggalkan (riwayat final).
   */
  async leaveGroup(userId: string, participantId: string) {
    const participant = await this.prisma.patunganParticipant.findFirst({
      where: { id: participantId, userId },
      include: { group: { select: { status: true } } },
    });
    if (!participant) {
      throw new NotFoundException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Data peserta tidak ditemukan' });
    }
    if (participant.status !== PatunganParticipantStatus.PENDING) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Hanya peserta yang belum menautkan order (PENDING) yang bisa keluar — order berbayar ikuti alur cancel/refund/dispute',
      });
    }
    if (participant.group.status === PatunganStatus.RELEASED) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Grup sudah dicairkan — tidak bisa keluar' });
    }
    // Predicate delete: balapan dengan linkOrder (PENDING → PAID) — bila
    // kalah race, count=0 → peserta sudah membayar, tolak keluar (fail closed).
    const deleted = await this.prisma.patunganParticipant.deleteMany({
      where: { id: participant.id, status: PatunganParticipantStatus.PENDING },
    });
    if (deleted.count === 0) {
      throw new ConflictException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Status peserta berubah saat keluar — coba lagi' });
    }
    return { left: true, participantId: participant.id, groupId: participant.groupId };
  }

  /**
   * Host inisiasi pencairan → masa sanggah 24 jam (CONTEST). Selama masa
   * sanggah, peserta yang keberatan membuka dispute via alur STANDAR
   * (DisputesService — kategori SERVICE_NOT_RENDERED bila jasa/barang tak
   * diberikan). Masa sanggah di sini HANYA trigger otomatis (deadline);
   * bukan mekanisme sengketa paralel — lihat processDeadlines.
   */
  async initiateRelease(hostId: string, groupId: string) {
    const group = await this.assertHostGroup(hostId, groupId);
    if (group.status !== PatunganStatus.TARGET_REACHED) {
      throw new BadRequestException({ code: ErrorCodes.PATUNGAN_TARGET_NOT_REACHED, message: 'Target belum tercapai' });
    }
    const contestEndsAt = new Date(Date.now() + PATUNGAN_CONTEST_HOURS * 60 * 60 * 1000);
    // M4: transisi TARGET_REACHED → CONTEST kondisional (predicate status) —
    // balapan dengan processDeadlines tidak boleh menimpa status.
    const claimed = await this.prisma.patunganGroup.updateMany({
      where: { id: group.id, status: PatunganStatus.TARGET_REACHED },
      data: { status: PatunganStatus.CONTEST, contestEndsAt },
    });
    if (claimed.count === 0) {
      throw new BadRequestException({ code: ErrorCodes.PATUNGAN_TARGET_NOT_REACHED, message: 'Status grup berubah saat inisiasi pencairan' });
    }
    return this.prisma.patunganGroup.findUnique({ where: { id: group.id } });
  }

  // ── Cron ────────────────────────────────────────────────────────────────

  /**
   * Dipanggil cron tiap beberapa menit:
   * - Grup OPEN yang deadline lewat & target tak tercapai → FAILED + refund
   *   otomatis: peserta PAID → REFUND_REQUIRED (fail closed, dieksekusi
   *   scheduler auto-refund via adminCancelOrder).
   * - Grup CONTEST yang masa sanggah habis → RELEASED (syarat pelepasan
   *   terpenuhi; dana cair lewat penyelesaian order escrow normal).
   */
  async processDeadlines(): Promise<{ failed: number; released: number }> {
    const now = new Date();
    let failed = 0;
    let released = 0;

    const expiredOpen = await this.prisma.patunganGroup.findMany({
      where: { status: PatunganStatus.OPEN, deadlineAt: { lt: now } },
      select: { id: true },
    });
    for (const g of expiredOpen) {
      // M4: klaim status + baca ulang agregat DALAM SATU tx pendek.
      // - Grup yang sudah berpindah (linkOrder menang → TARGET_REACHED) → lewati.
      // - Target tercapai tepat di garis deadline → TARGET_REACHED kondisional.
      // - Selain itu → FAILED kondisional; bila predicate gagal (kalah race),
      //   JANGAN refund — pemenang race yang menangani.
      // Refund (cancelOrder = tx + efek eksternal sendiri) dilakukan DI LUAR
      // tx setelah klaim berhasil, dengan peserta dibaca fresh.
      const outcome = await this.prisma.$transaction(async (tx) => {
        const fresh = await tx.patunganGroup.findUnique({
          where: { id: g.id },
          select: { status: true, targetAmount: true },
        });
        if (!fresh || fresh.status !== PatunganStatus.OPEN) return 'skipped' as const;
        const agg = await tx.patunganParticipant.aggregate({
          where: { groupId: g.id, status: PatunganParticipantStatus.PAID },
          _sum: { amount: true },
        });
        const totalPaid = agg._sum.amount ?? 0n;
        if (totalPaid >= fresh.targetAmount) {
          await tx.patunganGroup.updateMany({
            where: { id: g.id, status: PatunganStatus.OPEN },
            data: { status: PatunganStatus.TARGET_REACHED },
          });
          return 'reached' as const;
        }
        const claimed = await tx.patunganGroup.updateMany({
          where: { id: g.id, status: PatunganStatus.OPEN },
          data: { status: PatunganStatus.FAILED },
        });
        return claimed.count > 0 ? ('failed' as const) : ('skipped' as const);
      });
      if (outcome !== 'failed') continue;
      await this.refundParticipants(g.id);
      failed++;
    }

    // P2-5 (repair): peserta PAID di grup FAILED yang lolos dari refund
    // (race: bayar tepat setelah klaim FAILED, sebelum/saat snapshot
    // refundParticipants). Tandai REFUND_REQUIRED agar diproses auto-refund
    // commerce (fail closed). Idempoten via predicate status.
    const stuckPaid = await this.prisma.patunganParticipant.findMany({
      where: { status: PatunganParticipantStatus.PAID, group: { status: PatunganStatus.FAILED } },
      select: { id: true, groupId: true },
    });
    for (const sp of stuckPaid) {
      const flagged = await this.prisma.patunganParticipant.updateMany({
        where: { id: sp.id, status: PatunganParticipantStatus.PAID },
        data: { status: PatunganParticipantStatus.REFUND_REQUIRED },
      });
      if (flagged.count > 0) {
        this.logger.warn(`[P2-5-repair] Peserta ${sp.id} grup FAILED ${sp.groupId}: PAID → REFUND_REQUIRED`);
      }
    }

    const contestDone = await this.prisma.patunganGroup.findMany({
      where: { status: PatunganStatus.CONTEST, contestEndsAt: { lt: now } },
      select: { id: true },
    });
    for (const group of contestDone) {
      // LOW #3 (SEC-B ronde 2): CONTEST → RELEASED WAJIB cek sengketa peserta
      // terbuka. Status RELEASED berbohong bila order peserta sedang
      // disengketakan (pencairan aktual per-order tetap aman, tapi klaim grup
      // menyesatkan host/peserta). Bila ada sengketa terbuka → TAHAN
      // (fail closed): perpanjang masa sanggah 24 jam agar dispute sempat
      // selesai lewat alur existing, JANGAN release.
      // M4: transisi kondisional (predicate status) — grup yang sudah
      // berpindah (mis. dispute membatalkan contest) tidak ditimpa; bila
      // predicate gagal, lewati tanpa refund ganda.
      const outcome = await this.prisma.$transaction(async (tx) => {
        const linkedOrderIds = (
          await tx.patunganParticipant.findMany({
            where: { groupId: group.id, orderId: { not: null } },
            select: { orderId: true },
          })
        ).map((p) => p.orderId as string);
        let openDisputes = 0;
        if (linkedOrderIds.length > 0) {
          const [disputedOrders, openDisputeRows] = await Promise.all([
            tx.order.count({ where: { id: { in: linkedOrderIds }, status: OrderStatus.DISPUTED } }),
            tx.dispute.count({ where: { orderId: { in: linkedOrderIds }, status: { not: DisputeStatus.RESOLVED } } }),
          ]);
          openDisputes = disputedOrders + openDisputeRows;
        }
        if (openDisputes > 0) {
          const held = await tx.patunganGroup.updateMany({
            where: { id: group.id, status: PatunganStatus.CONTEST },
            data: { contestEndsAt: new Date(Date.now() + PATUNGAN_CONTEST_HOURS * 60 * 60 * 1000) },
          });
          if (held.count > 0) {
            this.logger.warn(
              `[SECURITY] Rilis patungan ${group.id} DITAHAN: ${openDisputes} sengketa peserta terbuka — masa sanggah diperpanjang ${PATUNGAN_CONTEST_HOURS} jam`,
            );
          }
          return 'held' as const;
        }
        const moved = await tx.patunganGroup.updateMany({
          where: { id: group.id, status: PatunganStatus.CONTEST },
          data: { status: PatunganStatus.RELEASED, releasedAt: new Date() },
        });
        if (moved.count === 0) return 'skipped' as const;
        await tx.patunganParticipant.updateMany({
          where: { groupId: group.id, status: PatunganParticipantStatus.PAID },
          data: { status: PatunganParticipantStatus.RELEASED },
        });
        return 'released' as const;
      });
      if (outcome === 'released') released++;
    }
    return { failed, released };
  }

  private async refundParticipants(groupId: string): Promise<void> {
    // Peserta dibaca FRESH setelah klaim FAILED — snapshot lama bisa basi.
    const participants = await this.prisma.patunganParticipant.findMany({
      where: { groupId },
      select: { id: true, orderId: true, status: true },
    });
    for (const p of participants) {
      if (p.status === PatunganParticipantStatus.PENDING) {
        await this.prisma.patunganParticipant.updateMany({
          where: { id: p.id, status: PatunganParticipantStatus.PENDING },
          data: { status: PatunganParticipantStatus.REFUNDED },
        });
        continue;
      }
      if (p.status !== PatunganParticipantStatus.PAID) continue;
      // P2-4: langsung tandai REFUND_REQUIRED — refund aktual dieksekusi
      // scheduler auto-refund via adminCancelOrder. Percobaan cancelOrder
      // user-level sebagai host adalah dead path (cancelOrder menolak
      // non-participant dan status PROCESSING+).
      await this.prisma.patunganParticipant.updateMany({
        where: { id: p.id, status: PatunganParticipantStatus.PAID },
        data: { status: PatunganParticipantStatus.REFUND_REQUIRED },
      });
    }
  }
}
