import { Injectable, NotFoundException, ForbiddenException, BadRequestException, ConflictException, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { JastipTripStatus, JastipParticipantStatus, OrderStatus, OrderType, OrderKind, FulfillmentType, ParticipantMode, OrderCategory, FeeResponsibility, Prisma } from '@prisma/client';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { toSen, toIdr } from '../../../common/utils/currency.util';
import { createPaginatedResponse, PaginatedResponse } from '../../../common/dto/pagination.dto';
import { OrderStateService } from '../../orders/order-state.service';
import { OrdersService } from '../../orders/orders.service';
import { CommerceOrderHooks } from '../commerce-order-hooks';
import { clampDeadlineDays } from '../commerce-order.util';
import {
  CreateJastipTripDto,
  AddJastipItemDto,
  JoinJastipDto,
  LockJastipPriceDto,
  LinkJastipOrderDto,
} from '../dto/commerce.dto';

/** Union penuh agar `.includes(status)` menerima semua nilai enum. */
const EDITABLE_TRIP_STATUSES: JastipTripStatus[] = [JastipTripStatus.DRAFT, JastipTripStatus.OPEN];
const PAID_ORDER_STATUSES: OrderStatus[] = [OrderStatus.PROCESSING, OrderStatus.IN_DELIVERY, OrderStatus.COMPLETED];
const CANCELLABLE_ORDER_STATUSES: OrderStatus[] = [OrderStatus.WAITING_CONFIRMATION, OrderStatus.WAITING_PAYMENT];
const PREPAID_PARTICIPANT_STATUSES: JastipParticipantStatus[] = [
  JastipParticipantStatus.JOINED,
  JastipParticipantStatus.PRICE_LOCKED,
];

/**
 * BE-COMMERCE (2026-10-01) — item 13: pre-order / jastip.
 *
 * Alur: host buat trip (DRAFT→OPEN) + katalog → buyer join → host KUNCI harga
 * (barang + fee jastip + ongkir terpisah & transparan) → buyer bayar via escrow
 * order NORMAL (existing flow) → buyer link orderId → PAID.
 * Host gagal dapat barang → fail trip: order yang masih bisa dibatalkan
 * di-cancel via OrderStateService (alur existing); order yang sudah dibayar
 * ditandai REFUND_REQUIRED (fail closed — refund dieksekusi lewat alur
 * return/dispute yang sudah ada, BUKAN logika uang baru di sini).
 */
@Injectable()
export class JastipService implements OnModuleInit {
  private readonly logger = new Logger(JastipService.name);

  constructor(
    private prisma: PrismaService,
    private orderStateService: OrderStateService,
    // POIN 2 (2026-10-04): create-order dari peserta memanggil
    // OrdersService.createOrder secara internal. Satu arah (commerce →
    // orders); OrdersModule tidak mengimpor CommerceModule → tanpa
    // circular DI.
    private ordersService: OrdersService,
  ) {}

  onModuleInit(): void {
    // POIN 2: peserta yang order-nya dibuat via create-order (belum bayar)
    // ditandai PAID saat pembayaran terkonfirmasi — via registry statis
    // CommerceOrderHooks (pola ChatOrderHooks), bukan DI.
    CommerceOrderHooks.onOrderPaid((orderPublicId) => this.markParticipantPaidByOrder(orderPublicId));
  }

  private async assertHostTrip(hostId: string, tripId: string) {
    const trip = await this.prisma.jastipTrip.findFirst({
      where: { id: tripId, hostId },
      include: { participants: { select: { id: true, status: true, orderId: true, buyerId: true } } },
    });
    if (!trip) throw new NotFoundException({ code: ErrorCodes.JASTIP_TRIP_NOT_FOUND, message: 'Trip jastip tidak ditemukan' });
    return trip;
  }

  // ── Host ────────────────────────────────────────────────────────────────

  async createTrip(hostId: string, dto: CreateJastipTripDto) {
    const deadline = new Date(dto.orderDeadline);
    if (Number.isNaN(deadline.getTime()) || deadline.getTime() <= Date.now()) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Deadline order harus di masa depan' });
    }
    return this.prisma.jastipTrip.create({
      data: {
        hostId,
        title: dto.title.trim(),
        description: dto.description?.trim() || null,
        orderDeadline: deadline,
        slotTotal: dto.slotTotal ?? 0,
        status: JastipTripStatus.DRAFT,
      },
    });
  }

  async openTrip(hostId: string, tripId: string) {
    const trip = await this.assertHostTrip(hostId, tripId);
    if (trip.status !== JastipTripStatus.DRAFT) {
      throw new BadRequestException({ code: ErrorCodes.JASTIP_TRIP_NOT_OPEN, message: 'Trip tidak dalam status DRAFT' });
    }
    return this.prisma.jastipTrip.update({ where: { id: trip.id }, data: { status: JastipTripStatus.OPEN } });
  }

  async addItem(hostId: string, tripId: string, dto: AddJastipItemDto) {
    const trip = await this.assertHostTrip(hostId, tripId);
    if (!EDITABLE_TRIP_STATUSES.includes(trip.status)) {
      throw new BadRequestException({ code: ErrorCodes.JASTIP_TRIP_NOT_OPEN, message: 'Trip sudah ditutup' });
    }
    return this.prisma.jastipItem.create({
      data: {
        tripId: trip.id,
        name: dto.name.trim(),
        estimatedPrice: dto.estimatedPriceIdr !== undefined ? toSen(dto.estimatedPriceIdr) : null,
        note: dto.note?.trim() || null,
      },
    });
  }

  async listMyTrips(hostId: string, page = 1, limit = 20): Promise<PaginatedResponse<Record<string, unknown>>> {
    const where: Prisma.JastipTripWhereInput = { hostId };
    const [rows, total] = await Promise.all([
      this.prisma.jastipTrip.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.jastipTrip.count({ where }),
    ]);
    return createPaginatedResponse(rows, total, page, limit);
  }

  async getTripDetail(userId: string, tripId: string) {
    const trip = await this.prisma.jastipTrip.findFirst({
      where: { id: tripId },
      include: {
        items: { orderBy: { createdAt: 'asc' } },
        participants: {
          select: { id: true, buyerId: true, itemSummary: true, goodsAmount: true, jastipFee: true, shippingCost: true, totalLocked: true, priceLockedAt: true, orderId: true, status: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!trip) throw new NotFoundException({ code: ErrorCodes.JASTIP_TRIP_NOT_FOUND, message: 'Trip jastip tidak ditemukan' });
    const isHost = trip.hostId === userId;
    const isParticipant = trip.participants.some((p) => p.buyerId === userId);
    // Harga terkunci + ringkasan item hanya transparan ke host + peserta
    // bersangkutan. SEC-C L1: itemSummary sebelumnya terlihat semua viewer —
    // samakan aturan masking-nya dengan harga terkunci.
    const participants = trip.participants.map((p) => {
      if (isHost || p.buyerId === userId) return p;
      const { goodsAmount, jastipFee, shippingCost, totalLocked, itemSummary, ...rest } = p;
      void goodsAmount; void jastipFee; void shippingCost; void totalLocked; void itemSummary;
      return rest;
    });
    return { ...trip, participants, isHost, isParticipant };
  }

  // ── Admin (monitoring saja, tanpa aksi finansial) ───────────────────────

  /** Nama display user untuk field hostName/buyerName di response admin. */
  private async userDisplayNames(userIds: string[]): Promise<Map<string, string | null>> {
    const uniq = [...new Set(userIds.filter((id) => !!id))];
    if (uniq.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: uniq } },
      select: { id: true, fullName: true },
    });
    return new Map(users.map((u) => [u.id, u.fullName]));
  }

  /** Daftar trip jastip untuk admin: filter status + pencarian judul/hostId. */
  async listAdminTrips(page = 1, limit = 20, status?: JastipTripStatus, q?: string) {
    const where: Prisma.JastipTripWhereInput = {};
    if (status && Object.values(JastipTripStatus).includes(status)) where.status = status;
    const keyword = q?.trim();
    if (keyword) {
      where.OR = [
        { title: { contains: keyword, mode: 'insensitive' } },
        { hostId: { contains: keyword } },
      ];
    }
    const [rows, total] = await Promise.all([
      this.prisma.jastipTrip.findMany({
        where,
        include: { participants: { select: { status: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.jastipTrip.count({ where }),
    ]);
    const names = await this.userDisplayNames(rows.map((t) => t.hostId));
    const items = rows.map((t) => ({
      id: t.id,
      title: t.title,
      hostId: t.hostId,
      hostName: names.get(t.hostId) ?? null,
      destination: null,
      orderDeadline: t.orderDeadline,
      status: t.status,
      slotCount: t.slotTotal > 0 ? t.slotTotal : null,
      orderCount: t.participants.filter(
        (p) => p.status === JastipParticipantStatus.PAID || p.status === JastipParticipantStatus.COMPLETED,
      ).length,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }));
    return createPaginatedResponse(items, total, page, limit);
  }

  /** Detail trip jastip untuk admin: katalog + daftar peserta (tanpa masking). */
  async getAdminTripDetail(tripId: string) {
    const trip = await this.prisma.jastipTrip.findFirst({
      where: { id: tripId },
      include: {
        items: { orderBy: { createdAt: 'asc' } },
        participants: {
          select: {
            id: true, buyerId: true, itemSummary: true, goodsAmount: true, jastipFee: true,
            shippingCost: true, totalLocked: true, priceLockedAt: true, orderId: true,
            status: true, createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!trip) throw new NotFoundException({ code: ErrorCodes.JASTIP_TRIP_NOT_FOUND, message: 'Trip jastip tidak ditemukan' });
    const names = await this.userDisplayNames([
      trip.hostId,
      ...trip.participants.map((p) => p.buyerId),
    ]);
    return {
      id: trip.id,
      title: trip.title,
      hostId: trip.hostId,
      hostName: names.get(trip.hostId) ?? null,
      destination: null,
      orderDeadline: trip.orderDeadline,
      status: trip.status,
      slotCount: trip.slotTotal > 0 ? trip.slotTotal : null,
      orderCount: trip.participants.length,
      createdAt: trip.createdAt,
      updatedAt: trip.updatedAt,
      catalog: trip.items.map((i) => ({
        id: i.id,
        name: i.name,
        price: i.estimatedPrice !== null ? toIdr(i.estimatedPrice) : null,
      })),
      orders: trip.participants.map((p) => ({
        id: p.id,
        buyerId: p.buyerId,
        buyerName: names.get(p.buyerId) ?? null,
        itemName: p.itemSummary,
        itemPrice: p.goodsAmount !== null ? toIdr(p.goodsAmount) : null,
        jastipFee: p.jastipFee !== null ? toIdr(p.jastipFee) : null,
        shippingCost: p.shippingCost !== null ? toIdr(p.shippingCost) : null,
        status: p.status,
        createdAt: p.createdAt,
      })),
    };
  }

  // ── Buyer ───────────────────────────────────────────────────────────────

  async joinTrip(buyerId: string, tripId: string, dto: JoinJastipDto) {
    const trip = await this.prisma.jastipTrip.findFirst({ where: { id: tripId } });
    if (!trip) throw new NotFoundException({ code: ErrorCodes.JASTIP_TRIP_NOT_FOUND, message: 'Trip jastip tidak ditemukan' });
    if (trip.status !== JastipTripStatus.OPEN) {
      throw new BadRequestException({ code: ErrorCodes.JASTIP_TRIP_NOT_OPEN, message: 'Trip tidak sedang dibuka' });
    }
    if (trip.hostId === buyerId) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Host tidak bisa join trip sendiri' });
    }
    if (new Date(trip.orderDeadline).getTime() <= Date.now()) {
      throw new BadRequestException({ code: ErrorCodes.JASTIP_TRIP_NOT_OPEN, message: 'Deadline order sudah lewat' });
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (trip.slotTotal > 0) {
          const used = await tx.jastipTrip.updateMany({
            where: { id: trip.id, slotUsed: { lt: trip.slotTotal } },
            data: { slotUsed: { increment: 1 } },
          });
          if (used.count === 0) throw new ConflictException({ code: ErrorCodes.JASTIP_SLOT_FULL, message: 'Slot trip penuh' });
        } else {
          await tx.jastipTrip.update({ where: { id: trip.id }, data: { slotUsed: { increment: 1 } } });
        }
        return tx.jastipParticipant.create({
          data: { tripId: trip.id, buyerId, itemSummary: dto.itemSummary.trim(), status: JastipParticipantStatus.JOINED },
        });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Kamu sudah join trip ini' });
      }
      throw e;
    }
  }

  /** Host mengunci harga: barang + fee jastip + ongkir TERPISAH & transparan. */
  async lockPrice(hostId: string, participantId: string, dto: LockJastipPriceDto) {
    const participant = await this.prisma.jastipParticipant.findFirst({
      where: { id: participantId },
      include: { trip: true },
    });
    if (!participant) throw new NotFoundException({ code: ErrorCodes.JASTIP_PARTICIPANT_NOT_FOUND, message: 'Peserta tidak ditemukan' });
    if (participant.trip.hostId !== hostId) {
      throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Hanya host yang bisa mengunci harga' });
    }
    if (participant.trip.status !== JastipTripStatus.OPEN) {
      throw new BadRequestException({ code: ErrorCodes.JASTIP_TRIP_NOT_OPEN, message: 'Trip tidak sedang dibuka' });
    }
    if (participant.status !== JastipParticipantStatus.JOINED) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Harga hanya bisa dikunci sekali (status JOINED)' });
    }
    const goodsAmount = toSen(dto.goodsAmountIdr);
    const jastipFee = toSen(dto.jastipFeeIdr);
    const shippingCost = toSen(dto.shippingCostIdr);
    const totalLocked = goodsAmount + jastipFee + shippingCost;
    if (totalLocked <= 0n) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Total terkunci harus > 0' });
    }
    return this.prisma.jastipParticipant.update({
      where: { id: participant.id },
      data: {
        goodsAmount, jastipFee, shippingCost, totalLocked,
        priceLockedAt: new Date(),
        status: JastipParticipantStatus.PRICE_LOCKED,
      },
    });
  }

  /**
   * POIN 2 (2026-10-04) — unifikasi transaksi escrow: buyer membuat escrow
   * order LANGSUNG dari peserta (menggantikan pola lama "buat order manual
   * lalu tempel ID via link-order").
   *
   * - Order dibuat via `OrdersService.createOrder` (internal, bukan HTTP)
   *   dengan `orderKind=JASTIP`; validasi/fee/voucher/notifikasi mengikuti
   *   alur order normal.
   * - `participant.orderId` terisi otomatis dalam SATU transaksi DB (advisory
   *   lock per peserta + predicate status) — dua request konkuren untuk
   *   peserta yang sama: satu menang, satu Conflict.
   * - Order berawal BELUM dibayar (WAITING_PAYMENT); peserta tetap
   *   PRICE_LOCKED sampai pembayaran terkonfirmasi → PAID via
   *   CommerceOrderHooks (real-time) / syncPaidParticipants (fallback cron).
   *
   * Catatan transaksi: `OrdersService.createOrder` menjalankan transaksinya
   * sendiri (retry serial orderId) sehingga tidak bisa di-nest ke tx luar
   * Prisma. Urutan di dalam tx: kunci advisory → verifikasi ulang → buat
   * order → tautkan. Bila createOrder gagal, tx luar rollback tanpa perubahan.
   */
  async createOrderFromParticipant(buyerId: string, participantId: string) {
    const participant = await this.prisma.jastipParticipant.findFirst({
      where: { id: participantId, buyerId },
      include: { trip: { select: { id: true, hostId: true, status: true, title: true, orderDeadline: true } } },
    });
    if (!participant) {
      throw new NotFoundException({ code: ErrorCodes.JASTIP_PARTICIPANT_NOT_FOUND, message: 'Peserta tidak ditemukan' });
    }
    if (participant.orderId) {
      throw new ConflictException({ code: ErrorCodes.ORDER_ALREADY_LINKED, message: 'Order sudah dibuat untuk peserta ini' });
    }
    if (participant.status !== JastipParticipantStatus.PRICE_LOCKED) {
      throw new BadRequestException({ code: ErrorCodes.JASTIP_PRICE_NOT_LOCKED, message: 'Harga belum dikunci host' });
    }
    if (participant.trip.status !== JastipTripStatus.OPEN) {
      throw new BadRequestException({ code: ErrorCodes.JASTIP_TRIP_NOT_OPEN, message: 'Trip tidak sedang dibuka' });
    }
    if (participant.totalLocked == null || participant.totalLocked <= 0n) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Total harga terkunci tidak valid' });
    }
    const host = await this.prisma.user.findUnique({
      where: { id: participant.trip.hostId },
      select: { username: true, isActive: true, isBanned: true },
    });
    if (!host?.username) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Host trip tidak valid' });
    }

    const orderValueIdr = toIdr(participant.totalLocked);
    const title = `Jastip: ${participant.trip.title}`.replace(/[<>"'&]/g, '').trim().slice(0, 100);
    const breakdown =
      `Rincian terkunci: barang ${toIdr(participant.goodsAmount ?? 0n)} + fee jastip ${toIdr(participant.jastipFee ?? 0n)} + ongkir ${toIdr(participant.shippingCost ?? 0n)}.`;
    const description = `Pesanan jastip "${participant.trip.title}" — ${participant.itemSummary}. ${breakdown}`
      .replace(/[<>"'&]/g, '')
      .trim()
      .slice(0, 500);
    const deliveryDeadlineDays = clampDeadlineDays(participant.trip.orderDeadline);

    return this.prisma.$transaction(async (tx) => {
      // Serialisasi create-order konkuren untuk peserta yang sama.
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, `commerce_create_order:${participant.id}`);
      const fresh = await tx.jastipParticipant.findUnique({
        where: { id: participant.id },
        select: { status: true, orderId: true },
      });
      if (!fresh) {
        throw new NotFoundException({ code: ErrorCodes.JASTIP_PARTICIPANT_NOT_FOUND, message: 'Peserta tidak ditemukan' });
      }
      if (fresh.orderId) {
        throw new ConflictException({ code: ErrorCodes.ORDER_ALREADY_LINKED, message: 'Order sudah dibuat untuk peserta ini' });
      }
      if (fresh.status !== JastipParticipantStatus.PRICE_LOCKED) {
        throw new BadRequestException({ code: ErrorCodes.JASTIP_PRICE_NOT_LOCKED, message: 'Harga belum dikunci host' });
      }
      const created = await this.ordersService.createOrder(buyerId, {
        role: 'BUYER',
        counterpartUsername: host.username as string,
        title,
        description,
        orderType: OrderType.PHYSICAL_GOODS,
        orderKind: OrderKind.JASTIP,
        // TX-UNIFIED-V2 (2026-10-06): jastip = preorder; dual-write dengan orderKind lama.
        fulfillment: FulfillmentType.PREORDER,
        participantMode: ParticipantMode.SINGLE,
        category: OrderCategory.FISIK,
        orderValue: orderValueIdr,
        deliveryDeadlineDays,
        feeResponsibility: FeeResponsibility.BUYER,
      });
      const orderRow = await tx.order.findUnique({ where: { orderId: created.orderId }, select: { id: true } });
      if (!orderRow) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Order gagal dibuat' });
      }
      const marked = await tx.jastipParticipant.updateMany({
        where: { id: participant.id, status: JastipParticipantStatus.PRICE_LOCKED, orderId: null },
        data: { orderId: orderRow.id },
      });
      if (marked.count === 0) {
        throw new ConflictException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Peserta sudah dalam proses' });
      }
      return {
        participantId: participant.id,
        orderId: created.orderId,
        orderKind: OrderKind.JASTIP,
        status: created.status,
        buyerPayAmount: created.feeCalculation.buyerPayAmount,
        confirmationDeadlineAt: created.confirmationDeadlineAt,
      };
    });
  }

  /**
   * Peserta PRICE_LOCKED yang order-nya (dibuat via create-order) sudah
   * berstatus bayar → PAID. Dipanggil real-time via CommerceOrderHooks
   * (post-commit pembayaran) dan fallback via syncPaidParticipants (cron).
   * Idempoten: predicate status, tanpa efek bila sudah PAID/terminal.
   */
  async markParticipantPaidByOrder(orderPublicId: string): Promise<void> {
    const order = await this.prisma.order.findFirst({
      where: { orderId: orderPublicId, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!order || !PAID_ORDER_STATUSES.includes(order.status)) return;
    await this.prisma.jastipParticipant.updateMany({
      where: { orderId: order.id, status: JastipParticipantStatus.PRICE_LOCKED },
      data: { status: JastipParticipantStatus.PAID },
    });
  }

  /**
   * Fallback cron (CommerceSchedulerService, tiap 5 menit): sinkronkan
   * peserta PRICE_LOCKED + orderId yang order-nya sudah bayar → PAID.
   * Menutup celah bila event CommerceOrderHooks terlewat (restart di tengah
   * pembayaran, dsb.). Mengembalikan jumlah peserta yang disinkronkan.
   */
  async syncPaidParticipants(): Promise<number> {
    const candidates = await this.prisma.jastipParticipant.findMany({
      where: { status: JastipParticipantStatus.PRICE_LOCKED, orderId: { not: null } },
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
    const res = await this.prisma.jastipParticipant.updateMany({
      where: { orderId: { in: paidOrders.map((o) => o.id) }, status: JastipParticipantStatus.PRICE_LOCKED },
      data: { status: JastipParticipantStatus.PAID },
    });
    return res.count;
  }

  /**
   * Buyer menautkan escrow order yang SUDAH DIBAYAR (dibuat via alur order
   * normal). Validasi: order milik buyer, seller = host, nilai = total
   * terkunci, status sudah bayar.
   *
   * @deprecated POIN 2 (2026-10-04): pola "tempel ID manual" digantikan
   * `POST /v1/jastip/participants/:id/create-order`
   * (`createOrderFromParticipant`) — order dibuat internal + orderId terisi
   * otomatis. Endpoint ini dipertahankan non-breaking untuk klien lama.
   */
  async linkOrder(buyerId: string, participantId: string, dto: LinkJastipOrderDto) {
    const participant = await this.prisma.jastipParticipant.findFirst({
      where: { id: participantId, buyerId },
      include: { trip: true },
    });
    if (!participant) throw new NotFoundException({ code: ErrorCodes.JASTIP_PARTICIPANT_NOT_FOUND, message: 'Peserta tidak ditemukan' });
    if (participant.status !== JastipParticipantStatus.PRICE_LOCKED) {
      throw new BadRequestException({ code: ErrorCodes.JASTIP_PRICE_NOT_LOCKED, message: 'Harga belum dikunci host' });
    }
    const order = await this.prisma.order.findFirst({
      where: { OR: [{ id: dto.orderId }, { orderId: dto.orderId }], deletedAt: null },
      select: { id: true, orderId: true, buyerId: true, sellerId: true, orderValue: true, status: true },
    });
    if (!order || order.buyerId !== buyerId) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Order tidak valid / bukan milikmu' });
    }
    if (order.sellerId !== participant.trip.hostId) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Seller order harus host trip ini' });
    }
    if (order.orderValue !== participant.totalLocked) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Nilai order harus sama persis dengan total harga terkunci',
      });
    }
    if (!PAID_ORDER_STATUSES.includes(order.status)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Order belum dibayar' });
    }
    // Satu order berbayar TIDAK BOLEH ditautkan ke 2 peserta/trip (cegah
    // pelunasan palsu lewat double-link escrow order yang sama) — cek di
    // DALAM tx: peserta jastip lain + peserta patungan (lintas modul).
    try {
      return await this.prisma.$transaction(async (tx) => {
        // LOW #2: kunci advisory per order — serialisasi linkOrder jastip vs
        // patungan untuk order yang sama; menutup race lintas tabel.
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, `commerce_link_order:${order.id}`);
        const [linkedJastip, linkedPatungan] = await Promise.all([
          tx.jastipParticipant.findFirst({
            where: { orderId: order.id, id: { not: participant.id } },
            select: { id: true },
          }),
          tx.patunganParticipant.findFirst({ where: { orderId: order.id }, select: { id: true } }),
        ]);
        if (linkedJastip || linkedPatungan) {
          throw new BadRequestException({
            code: ErrorCodes.ORDER_ALREADY_LINKED,
            message: 'Order ini sudah ditautkan ke peserta lain',
          });
        }
        // Predicate status: PRICE_LOCKED → PAID atomik; dua linkOrder konkuren
        // untuk peserta yang sama tidak bisa double-link.
        const marked = await tx.jastipParticipant.updateMany({
          where: { id: participant.id, status: JastipParticipantStatus.PRICE_LOCKED },
          data: { orderId: order.id, status: JastipParticipantStatus.PAID },
        });
        if (marked.count === 0) {
          throw new BadRequestException({
            code: ErrorCodes.VALIDATION_ERROR,
            message: 'Peserta sudah dalam proses / selesai',
          });
        }
        // TX-UNIFIED-V2 (2026-10-06) — perbaiki M2 audit: order yang ditautkan
        // manual juga harus tercatat dengan dimensi baru yang benar
        // (sebelumnya hanya orderId yang ditulis, orderKind tetap DIRECT).
        await tx.order.update({
          where: { id: order.id },
          data: {
            orderKind: OrderKind.JASTIP,
            fulfillment: FulfillmentType.PREORDER,
            participantMode: ParticipantMode.SINGLE,
            category: OrderCategory.FISIK,
          },
        });
        return tx.jastipParticipant.findUnique({ where: { id: participant.id } });
      });
    } catch (e) {
      // Race antar-request: unique constraint DB (orderId) menolak link ganda.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException({
          code: ErrorCodes.ORDER_ALREADY_LINKED,
          message: 'Order ini sudah ditautkan ke peserta jastip lain',
        });
      }
      throw e;
    }
  }

  /**
   * Host gagal dapat barang → trip dibatalkan + refund otomatis SEJAUH
   * dimungkinkan alur existing: order yang masih cancellable di-cancel via
   * OrderStateService; order yang sudah dibayar → REFUND_REQUIRED (fail
   * closed, dieksekusi scheduler auto-refund M2).
   *
   * M3 (SEC-B ronde 2): atomik + idempoten + retry-safe.
   * - Transisi trip → CANCELLED memakai conditional updateMany (predicate
   *   status): dua pemanggil konkuren tidak saling menimpa.
   * - Bila trip SUDAH CANCELLED (retry pasca-crash di tengah loop), JANGAN
   *   tolak — lanjutkan memproses sisa peserta.
   * - Setiap peserta dibaca FRESH dan statusnya diubah via updateMany
   *   ber-predicate; peserta yang sudah terminal (REFUNDED/REFUND_REQUIRED/
   *   CANCELLED) tidak diproses ulang.
   * - cancelOrder (memiliki transaksi + efek eksternal sendiri) tidak bisa
   *   masuk satu tx dengan update status: urutannya cancel dulu, lalu tandai
   *   status; bila cancel melempar karena order sudah ter-cancel jalur lain,
   *   peserta tetap ditandai REFUNDED (bukan REFUND_REQUIRED).
   */
  async failTrip(hostId: string, tripId: string, reason?: string) {
    const trip = await this.assertHostTrip(hostId, tripId);
    if (trip.status === JastipTripStatus.COMPLETED) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Trip sudah selesai' });
    }
    const claimed = await this.prisma.jastipTrip.updateMany({
      where: { id: trip.id, status: { notIn: [JastipTripStatus.CANCELLED, JastipTripStatus.COMPLETED] } },
      data: { status: JastipTripStatus.CANCELLED },
    });
    if (claimed.count === 0) {
      // Retry pasca-crash (trip sudah CANCELLED oleh percobaan sebelumnya)
      // atau balapan dengan penutupan lain — verifikasi via baca ulang.
      const fresh = await this.prisma.jastipTrip.findUnique({ where: { id: trip.id }, select: { status: true } });
      if (!fresh || fresh.status !== JastipTripStatus.CANCELLED) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Trip sudah selesai/dibatalkan' });
      }
    }

    // Baca ulang peserta FRESH — snapshot assertHostTrip bisa basi saat retry.
    const participants = await this.prisma.jastipParticipant.findMany({
      where: { tripId: trip.id },
      select: { id: true, status: true, orderId: true },
    });

    const results: Array<{ participantId: string; outcome: string }> = [];
    for (const p of participants) {
      results.push({ participantId: p.id, outcome: await this.failTripParticipant(p, hostId, reason) });
    }
    return { tripId: trip.id, status: JastipTripStatus.CANCELLED, results };
  }

  /** Satu peserta dalam failTrip — idempoten, aman di-retry. */
  private async failTripParticipant(
    p: { id: string; status: JastipParticipantStatus; orderId: string | null },
    hostId: string,
    reason?: string,
  ): Promise<string> {
    // Guard retry: yang sudah terminal tidak diproses ulang.
    if (
      p.status === JastipParticipantStatus.REFUNDED ||
      p.status === JastipParticipantStatus.REFUND_REQUIRED ||
      p.status === JastipParticipantStatus.CANCELLED ||
      p.status === JastipParticipantStatus.COMPLETED
    ) {
      return p.status;
    }
    if (p.status === JastipParticipantStatus.PAID) {
      if (!p.orderId) {
        // Data inkonsisten (PAID tanpa order): fail closed — tandai
        // REFUND_REQUIRED agar dieksekusi scheduler auto-refund / ops.
        await this.prisma.jastipParticipant.updateMany({
          where: { id: p.id, status: JastipParticipantStatus.PAID },
          data: { status: JastipParticipantStatus.REFUND_REQUIRED },
        });
        return 'REFUND_REQUIRED';
      }
      const order = await this.prisma.order.findUnique({
        where: { id: p.orderId },
        select: { orderId: true, status: true },
      });
      if (order && CANCELLABLE_ORDER_STATUSES.includes(order.status)) {
        try {
          await this.orderStateService.cancelOrder(order.orderId, hostId, 'OTHER', `Jastip gagal: ${reason ?? 'host tidak mendapatkan barang'}`.slice(0, 200));
          await this.prisma.jastipParticipant.updateMany({
            where: { id: p.id, status: JastipParticipantStatus.PAID },
            data: { status: JastipParticipantStatus.REFUNDED },
          });
          return 'REFUNDED';
        } catch (e) {
          this.logger.warn(`Cancel order jastip gagal participant=${p.id}: ${(e as Error).message}`);
          // Race: order ter-cancel jalur lain di tengah jalan → refund sudah
          // ditangani pemenang race; jangan turunkan ke REFUND_REQUIRED.
          const fresh = await this.prisma.order.findUnique({ where: { id: p.orderId }, select: { status: true } });
          if (fresh?.status === OrderStatus.CANCELLED) {
            await this.prisma.jastipParticipant.updateMany({
              where: { id: p.id, status: JastipParticipantStatus.PAID },
              data: { status: JastipParticipantStatus.REFUNDED },
            });
            return 'REFUNDED';
          }
        }
      }
      await this.prisma.jastipParticipant.updateMany({
        where: { id: p.id, status: JastipParticipantStatus.PAID },
        data: { status: JastipParticipantStatus.REFUND_REQUIRED },
      });
      return 'REFUND_REQUIRED';
    }
    if (PREPAID_PARTICIPANT_STATUSES.includes(p.status)) {
      await this.prisma.jastipParticipant.updateMany({
        where: { id: p.id, status: p.status },
        data: { status: JastipParticipantStatus.CANCELLED },
      });
      return 'CANCELLED';
    }
    return p.status;
  }

  /** Cron: trip OPEN yang deadline-nya lewat → CLOSED; peserta belum bayar → CANCELLED. */
  async closeExpiredTrips(): Promise<number> {
    const now = new Date();
    const expired = await this.prisma.jastipTrip.findMany({
      where: { status: JastipTripStatus.OPEN, orderDeadline: { lt: now } },
      select: { id: true },
    });
    for (const t of expired) {
      await this.prisma.$transaction(async (tx) => {
        // M3/M4: predicate status — trip yang sudah CANCELLED via failTrip
        // (balapan dengan cron) TIDAK ditimpa menjadi CLOSED.
        await tx.jastipTrip.updateMany({
          where: { id: t.id, status: JastipTripStatus.OPEN },
          data: { status: JastipTripStatus.CLOSED },
        });
        await tx.jastipParticipant.updateMany({
          where: { tripId: t.id, status: { in: [JastipParticipantStatus.JOINED, JastipParticipantStatus.PRICE_LOCKED] } },
          data: { status: JastipParticipantStatus.CANCELLED },
        });
      });
    }
    return expired.length;
  }
}
