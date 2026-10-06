import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { Prisma, ProductType, SlotBookingStatus, OrderType, OrderKind, FulfillmentType, ParticipantMode, OrderCategory, FeeResponsibility } from '@prisma/client';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { toIdr } from '../../../common/utils/currency.util';
import { createPaginatedResponse, PaginatedResponse } from '../../../common/dto/pagination.dto';
import { OrdersService } from '../../orders/orders.service';
import { clampDeadlineDays } from '../commerce-order.util';
import { CreateServiceSlotDto, BookServiceSlotDto } from '../dto/commerce.dto';

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * BE-COMMERCE (2026-10-01) — item 10: booking jasa via kalender.
 * Slot ketersediaan per produk JASA; buyer booking slot (kapasitas terbatas).
 */
@Injectable()
export class ServiceBookingService {
  constructor(
    private prisma: PrismaService,
    // POIN 2 (2026-10-04): bookAndCreateOrder memanggil
    // OrdersService.createOrder secara internal. Satu arah (commerce →
    // orders); tanpa circular DI.
    private ordersService: OrdersService,
  ) {}

  private async assertSellerShowcase(sellerId: string, showcaseId: string) {
    const row = await this.prisma.userShowcase.findFirst({
      where: { id: showcaseId, userId: sellerId, deletedAt: null },
      select: { id: true, productType: true },
    });
    if (!row) throw new NotFoundException({ code: ErrorCodes.SHOWCASE_NOT_FOUND, message: 'Etalase tidak ditemukan' });
    if (row.productType !== ProductType.JASA) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_PRODUCT_TYPE,
        message: 'Slot booking hanya untuk produk bertipe JASA',
      });
    }
    return row;
  }

  private validateTimeRange(startTime: string, endTime: string): void {
    if (!TIME_RE.test(startTime) || !TIME_RE.test(endTime) || startTime >= endTime) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Rentang jam tidak valid (HH:mm, mulai < selesai)' });
    }
  }

  async createSlot(sellerId: string, dto: CreateServiceSlotDto) {
    await this.assertSellerShowcase(sellerId, dto.showcaseId);
    this.validateTimeRange(dto.startTime, dto.endTime);
    const slotDate = new Date(`${dto.slotDate}T00:00:00+07:00`);
    if (Number.isNaN(slotDate.getTime())) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Format tanggal tidak valid' });
    }
    const todayWib = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    todayWib.setHours(0, 0, 0, 0);
    if (slotDate < todayWib) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Slot tidak bisa di masa lalu' });
    }
    return this.prisma.serviceSlot.create({
      data: {
        showcaseId: dto.showcaseId,
        sellerId,
        slotDate,
        startTime: dto.startTime,
        endTime: dto.endTime,
        capacity: dto.capacity ?? 1,
        note: dto.note?.trim() || null,
      },
    });
  }

  async listSlots(showcaseId: string, from?: string, page = 1, limit = 20): Promise<PaginatedResponse<Record<string, unknown>>> {
    const where: Prisma.ServiceSlotWhereInput = {
      showcaseId,
      isActive: true,
      slotDate: { gte: from ? new Date(`${from}T00:00:00+07:00`) : new Date() },
    };
    const [rows, total] = await Promise.all([
      this.prisma.serviceSlot.findMany({
        where,
        orderBy: [{ slotDate: 'asc' }, { startTime: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.serviceSlot.count({ where }),
    ]);
    return createPaginatedResponse(
      rows.map((r) => ({ ...r, remaining: r.capacity - r.bookedCount })),
      total,
      page,
      limit,
    );
  }

  async deleteSlot(sellerId: string, slotId: string) {
    const slot = await this.prisma.serviceSlot.findFirst({ where: { id: slotId, sellerId }, select: { id: true } });
    if (!slot) throw new NotFoundException({ code: ErrorCodes.SLOT_NOT_FOUND, message: 'Slot tidak ditemukan' });
    await this.prisma.serviceSlot.update({ where: { id: slot.id }, data: { isActive: false } });
    return { id: slot.id };
  }

  /**
   * Booking slot oleh buyer. Fail-closed: slot penuh / sudah booking /
   * tidak aktif → 4xx. bookedCount di-update atomik dengan guard kapasitas.
   */
  async bookSlot(userId: string, slotId: string) {
    const slot = await this.loadBookableSlot(userId, slotId);
    const dup = await this.prisma.serviceSlotBooking.findUnique({
      where: { slotId_userId: { slotId: slot.id, userId } },
      select: { id: true, status: true },
    });
    if (dup && dup.status === SlotBookingStatus.BOOKED) {
      throw new ConflictException({ code: ErrorCodes.SLOT_ALREADY_BOOKED, message: 'Kamu sudah booking slot ini' });
    }
    return this.prisma.$transaction((tx) => this.claimSlotTx(tx, slot.id, userId, slot.capacity));
  }

  /**
   * POIN 2 (2026-10-04) — unifikasi transaksi escrow: booking slot jasa +
   * pembuatan escrow order dalam satu alur. Sebelumnya `orderId` booking
   * TIDAK PERNAH ditulis.
   *
   * - Klaim slot memakai logika yang sama dengan bookSlot (atomik, guard
   *   kapasitas). Booking existing yang masih BOOKED tanpa order dipakai
   *   ulang (tidak klaim kapasitas dua kali).
   * - Setelah booking sukses, order dibuat via `OrdersService.createOrder`
   *   (internal) dengan `orderKind=SERVICE_BOOKING`, `orderType=SERVICE`,
   *   lalu `ServiceSlotBooking.orderId` diisi (predicate: BOOKED + orderId
   *   null — anti double-attach).
   * - Harga: `dto.priceIdr` bila diisi, else priceMin etalase JASA.
   */
  async bookAndCreateOrder(userId: string, slotId: string, dto: BookServiceSlotDto = {}) {
    const slot = await this.loadBookableSlot(userId, slotId);
    const existing = await this.prisma.serviceSlotBooking.findUnique({
      where: { slotId_userId: { slotId: slot.id, userId } },
      select: { id: true, status: true, orderId: true },
    });
    let bookingId: string;
    if (existing && existing.status === SlotBookingStatus.BOOKED) {
      if (existing.orderId) {
        throw new ConflictException({ code: ErrorCodes.ORDER_ALREADY_LINKED, message: 'Order sudah dibuat untuk booking ini' });
      }
      bookingId = existing.id;
    } else {
      const booking = await this.prisma.$transaction((tx) => this.claimSlotTx(tx, slot.id, userId, slot.capacity));
      bookingId = booking.id;
    }

    const showcase = await this.prisma.userShowcase.findUnique({
      where: { id: slot.showcaseId },
      select: { title: true, priceMin: true },
    });
    let priceIdr = dto.priceIdr;
    if (priceIdr === undefined || priceIdr === null) {
      if (showcase?.priceMin == null) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Harga jasa belum ditentukan — isi priceIdr atau set harga di etalase',
        });
      }
      priceIdr = toIdr(showcase.priceMin);
    }
    if (!Number.isSafeInteger(priceIdr) || priceIdr <= 0) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'priceIdr tidak valid' });
    }
    const seller = await this.prisma.user.findUnique({ where: { id: slot.sellerId }, select: { username: true } });
    if (!seller?.username) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Seller slot tidak valid' });
    }

    // slotDate disimpan sebagai Date @db.Date zona WIB — tampilkan YYYY-MM-DD WIB.
    const slotDateWib = new Date(slot.slotDate.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const slotLabel = `${slotDateWib} ${slot.startTime}-${slot.endTime}`;
    const title = `Booking jasa: ${showcase?.title ?? 'Jasa'}`.replace(/[<>"'&]/g, '').trim().slice(0, 100);
    const description = `Booking jasa "${showcase?.title ?? ''}" — slot ${slotLabel}.${slot.note ? ` Catatan: ${slot.note}` : ''}`
      .replace(/[<>"'&]/g, '')
      .trim()
      .slice(0, 500);

    // createOrder menjalankan transaksinya sendiri (lihat jastip/patungan):
    // booking sudah diklaim di atas; predicate di bawah mencegah orderId
    // tertimpa bila dua request balapan.
    const created = await this.ordersService.createOrder(userId, {
      role: 'BUYER',
      counterpartUsername: seller.username,
      title,
      description,
      orderType: OrderType.SERVICE,
      orderKind: OrderKind.SERVICE_BOOKING,
      // TX-UNIFIED-V2 (2026-10-06): booking jasa = JASA; dual-write dengan orderKind lama.
      fulfillment: FulfillmentType.BIASA,
      participantMode: ParticipantMode.SINGLE,
      category: OrderCategory.JASA,
      orderValue: priceIdr,
      deliveryDeadlineDays: clampDeadlineDays(slot.slotDate),
      feeResponsibility: FeeResponsibility.BUYER,
    });
    const orderRow = await this.prisma.order.findUnique({ where: { orderId: created.orderId }, select: { id: true } });
    if (!orderRow) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Order gagal dibuat' });
    }
    const marked = await this.prisma.serviceSlotBooking.updateMany({
      where: { id: bookingId, status: SlotBookingStatus.BOOKED, orderId: null },
      data: { orderId: orderRow.id },
    });
    if (marked.count === 0) {
      throw new ConflictException({ code: ErrorCodes.ORDER_ALREADY_LINKED, message: 'Booking sudah tertaut order' });
    }
    return {
      bookingId,
      orderId: created.orderId,
      orderKind: OrderKind.SERVICE_BOOKING,
      status: created.status,
      buyerPayAmount: created.feeCalculation.buyerPayAmount,
      confirmationDeadlineAt: created.confirmationDeadlineAt,
    };
  }

  /** Slot aktif + bukan milik sendiri. Dipakai bookSlot & bookAndCreateOrder. */
  private async loadBookableSlot(userId: string, slotId: string) {
    const slot = await this.prisma.serviceSlot.findFirst({
      where: { id: slotId, isActive: true },
      select: {
        id: true, sellerId: true, capacity: true, bookedCount: true,
        showcaseId: true, slotDate: true, startTime: true, endTime: true, note: true,
      },
    });
    if (!slot) throw new NotFoundException({ code: ErrorCodes.SLOT_NOT_FOUND, message: 'Slot tidak ditemukan / tidak aktif' });
    if (slot.sellerId === userId) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Seller tidak bisa booking slot sendiri' });
    }
    return slot;
  }

  /** Klaim kapasitas atomik + upsert booking — isi tx dari bookSlot (dipakai ulang). */
  private async claimSlotTx(tx: Prisma.TransactionClient, slotId: string, userId: string, capacity: number) {
    const claimed = await tx.serviceSlot.updateMany({
      where: { id: slotId, bookedCount: { lt: capacity }, isActive: true },
      data: { bookedCount: { increment: 1 } },
    });
    if (claimed.count === 0) {
      throw new ConflictException({ code: ErrorCodes.SLOT_FULL, message: 'Slot sudah penuh' });
    }
    return tx.serviceSlotBooking.upsert({
      where: { slotId_userId: { slotId, userId } },
      create: { slotId, userId, status: SlotBookingStatus.BOOKED },
      update: { status: SlotBookingStatus.BOOKED },
      select: { id: true, slotId: true, status: true, createdAt: true },
    });
  }

  async cancelBooking(userId: string, bookingId: string) {
    const booking = await this.prisma.serviceSlotBooking.findFirst({
      where: { id: bookingId, userId, status: SlotBookingStatus.BOOKED },
      select: { id: true, slotId: true },
    });
    if (!booking) throw new NotFoundException({ code: ErrorCodes.BOOKING_NOT_FOUND, message: 'Booking tidak ditemukan' });
    await this.prisma.$transaction(async (tx) => {
      await tx.serviceSlotBooking.update({ where: { id: booking.id }, data: { status: SlotBookingStatus.CANCELLED } });
      await tx.serviceSlot.update({ where: { id: booking.slotId }, data: { bookedCount: { decrement: 1 } } });
    });
    return { id: booking.id, status: SlotBookingStatus.CANCELLED };
  }

  async myBookings(userId: string, page = 1, limit = 20) {
    const where: Prisma.ServiceSlotBookingWhereInput = { userId };
    const [rows, total] = await Promise.all([
      this.prisma.serviceSlotBooking.findMany({
        where,
        include: { slot: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.serviceSlotBooking.count({ where }),
    ]);
    return createPaginatedResponse(rows, total, page, limit);
  }

  /**
   * POIN 2 (2026-10-04): daftar booking jasa untuk panel admin
   * (GET /v1/admin/service-bookings). Read-only — TANPA aksi finansial.
   *
   * Kontrak: query page/limit/status/search; respons paginasi standar dengan
   * relasi `slot` (Prisma) + `user` (soft FK → di-resolve manual).
   * `search` mencocokkan ID booking atau username/nama lengkap pemesan.
   */
  async listAdminBookings(
    page = 1,
    limit = 20,
    status?: SlotBookingStatus,
    search?: string,
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    const where: Prisma.ServiceSlotBookingWhereInput = {};
    if (status !== undefined) {
      if (!Object.values(SlotBookingStatus).includes(status)) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Status booking tidak valid' });
      }
      where.status = status;
    }
    const term = search?.trim();
    if (term) {
      // Cari user yang cocok dulu (username/nama), lalu filter booking-nya.
      const matchedUsers = await this.prisma.user.findMany({
        where: {
          OR: [
            { username: { contains: term, mode: 'insensitive' } },
            { fullName: { contains: term, mode: 'insensitive' } },
          ],
        },
        select: { id: true },
        take: 50,
      });
      const or: Prisma.ServiceSlotBookingWhereInput[] = [{ id: { contains: term } }];
      if (matchedUsers.length > 0) or.push({ userId: { in: matchedUsers.map((u) => u.id) } });
      where.OR = or;
    }
    const [rows, total] = await Promise.all([
      this.prisma.serviceSlotBooking.findMany({
        where,
        include: { slot: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.serviceSlotBooking.count({ where }),
    ]);
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const users =
      userIds.length > 0
        ? await this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, username: true, fullName: true, avatarUrl: true },
          })
        : [];
    const userMap = new Map(
      users.map((u) => [u.id, { userId: u.id, username: u.username, fullName: u.fullName, avatarUrl: u.avatarUrl }]),
    );
    return createPaginatedResponse(
      rows.map((r) => ({ ...r, user: userMap.get(r.userId) ?? null })),
      total,
      page,
      limit,
    );
  }
}
