import { Injectable, NotFoundException, BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { Prisma, ProductType, SlotBookingStatus, OrderType, OrderKind, FeeResponsibility, OrderStatus, FulfillmentType, ParticipantMode, OrderCategory } from '@prisma/client';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { toIdr } from '../../../common/utils/currency.util';
import { createPaginatedResponse, PaginatedResponse } from '../../../common/dto/pagination.dto';
import { OrdersService } from '../../orders/orders.service';
import { OrderStateService } from '../../orders/order-state.service';
import { clampDeadlineDays } from '../commerce-order.util';
import { CreateServiceSlotDto, BookServiceSlotDto } from '../dto/commerce.dto';
import { escapeLikePattern } from '../../../common/utils/search.util';

/** Tengah malam WIB hari ini (@db.Date dibandingkan per tanggal, bukan jam). */
function todayWibStart(now = new Date()): Date {
  const wib = new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
  return new Date(`${wib}T00:00:00+07:00`);
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * BE-COMMERCE (2026-10-01) — item 10: booking jasa via kalender.
 * Slot ketersediaan per produk JASA; buyer booking slot (kapasitas terbatas).
 */
@Injectable()
export class ServiceBookingService {
  private readonly logger = new Logger(ServiceBookingService.name);

  constructor(
    private prisma: PrismaService,
    // POIN 2 (2026-10-04): bookAndCreateOrder memanggil
    // OrdersService.createOrder secara internal. Satu arah (commerce →
    // orders); tanpa circular DI.
    private ordersService: OrdersService,
    // P2-2: cascade pembatalan order escrow saat booking dibatalkan.
    // CommerceModule sudah mengimpor OrdersModule (pola jastip/patungan).
    private orderStateService: OrderStateService,
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
    // BES-08 (audit etalase 2026-10-10): `from` tak valid → 400 (dulu Invalid
    // Date → Prisma melempar → 500); default = tengah malam WIB hari ini —
    // dulu `new Date()` (sekarang) membuat slot HARI INI hilang setelah 07:00
    // WIB karena @db.Date dibandingkan dengan timestamp.
    if (from !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'from harus berformat YYYY-MM-DD' });
    }
    const where: Prisma.ServiceSlotWhereInput = {
      showcaseId,
      isActive: true,
      slotDate: { gte: from ? new Date(`${from}T00:00:00+07:00`) : todayWibStart() },
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
    const sellerUsername: string = seller.username;

    // slotDate disimpan sebagai Date @db.Date zona WIB — tampilkan YYYY-MM-DD WIB.
    const slotDateWib = new Date(slot.slotDate.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const slotLabel = `${slotDateWib} ${slot.startTime}-${slot.endTime}`;
    const title = `Booking jasa: ${showcase?.title ?? 'Jasa'}`.replace(/[<>"'&]/g, '').trim().slice(0, 100);
    const description = `Booking jasa "${showcase?.title ?? ''}" — slot ${slotLabel}.${slot.note ? ` Catatan: ${slot.note}` : ''}`
      .replace(/[<>"'&]/g, '')
      .trim()
      .slice(0, 500);

    // P2-1: serialisasi create-order + attach per booking (pola yang sama
    // dengan jastip/patungan: pg_advisory_xact_lock + re-check di dalam tx).
    // Tanpa ini, dua request konkuren untuk booking yang sama bisa membuat
    // DUA order — satu menjadi yatim (WAITING_CONFIRMATION, dana belum
    // bergerak tapi order menggantung selamanya).
    // createOrder berjalan di tx-nya sendiri (via ordersService, pola
    // existing); attach memakai predicate orderId:null sebagai guard kedua.
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, `commerce_create_order:booking:${bookingId}`);
      const fresh = await tx.serviceSlotBooking.findUnique({
        where: { id: bookingId },
        select: { status: true, orderId: true },
      });
      if (!fresh || fresh.status !== SlotBookingStatus.BOOKED) {
        throw new ConflictException({ code: ErrorCodes.BOOKING_NOT_FOUND, message: 'Booking tidak valid / sudah berubah' });
      }
      if (fresh.orderId) {
        throw new ConflictException({ code: ErrorCodes.ORDER_ALREADY_LINKED, message: 'Order sudah dibuat untuk booking ini' });
      }
      const created = await this.ordersService.createOrder(userId, {
        role: 'BUYER',
        counterpartUsername: sellerUsername,
        title,
        description,
        orderType: OrderType.SERVICE,
        orderKind: OrderKind.SERVICE_BOOKING,
        // TX-UNIFIED-V2 (2026-10-06, audit2 P0-B): booking jasa = JASA, 1-by-1,
        // fulfillment BIASA. Eksplisit di sini (derivasi otomatis di
        // createOrderTx tetap ada sebagai pengaman).
        fulfillment: FulfillmentType.BIASA,
        participantMode: ParticipantMode.SINGLE,
        category: OrderCategory.JASA,
        orderValue: priceIdr,
        deliveryDeadlineDays: clampDeadlineDays(slot.slotDate),
        feeResponsibility: FeeResponsibility.BUYER,
      });
      const orderRow = await tx.order.findUnique({ where: { orderId: created.orderId }, select: { id: true } });
      if (!orderRow) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Order gagal dibuat' });
      }
      const marked = await tx.serviceSlotBooking.updateMany({
        where: { id: bookingId, status: SlotBookingStatus.BOOKED, orderId: null },
        data: { orderId: orderRow.id },
      });
      if (marked.count === 0) {
        // P2-1: attach gagal setelah order ter-commit → order yatim.
        // Best-effort cleanup: order baru berstatus WAITING_* sehingga bisa
        // di-cancel oleh buyer pembuatnya. Jangan biarkan menggantung.
        await this.cancelOrphanOrder(userId, created.orderId);
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
    });
    return result;
  }

  /**
   * P2-1: best-effort cleanup order yatim — order ter-commit tetapi gagal
   * ditautkan ke booking (race yang lolos dari advisory lock). Order yang
   * baru dibuat berstatus WAITING_* sehingga bisa di-cancel oleh buyer
   * pembuatnya. Tidak pernah throw — kegagalan cleanup hanya di-log
   * (order yatim akan dibersihkan cron expire-unconfirmed).
   */
  private async cancelOrphanOrder(buyerId: string, orderPublicId: string): Promise<void> {
    try {
      await this.orderStateService.cancelOrder(orderPublicId, buyerId, 'OTHER', 'Cleanup P2-1: order yatim gagal ditautkan ke booking');
    } catch (e) {
      this.logger.warn(`[P2-1] Gagal cleanup order yatim ${orderPublicId}: ${(e as Error).message}`);
    }
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
    // BES-10 (audit etalase 2026-10-10): slot yang tanggalnya sudah lewat
    // tidak bisa di-booking.
    if (slot.slotDate instanceof Date && slot.slotDate.getTime() < todayWibStart().getTime()) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Slot sudah lewat' });
    }
    // BES-10: etalase jasa harus masih tayang (bukan dihapus/nonaktif/takedown).
    const showcase = await this.prisma.userShowcase.findFirst({
      where: { id: slot.showcaseId, deletedAt: null, isActive: true },
      select: { id: true },
    });
    if (!showcase) {
      throw new NotFoundException({ code: ErrorCodes.SLOT_NOT_FOUND, message: 'Etalase jasa tidak lagi tersedia' });
    }
    return slot;
  }

  /** Klaim kapasitas atomik + upsert booking — isi tx dari bookSlot (dipakai ulang). */
  private async claimSlotTx(tx: Prisma.TransactionClient, slotId: string, userId: string, capacity: number) {
    // BES-06 (audit etalase 2026-10-10): klaim BARIS BOOKING dulu, baru
    // kapasitas. Dulu increment lalu upsert — dua request paralel user yang
    // sama lolos pre-check, keduanya menaikkan bookedCount, upsert kedua
    // hanya menimpa baris yang sama → kapasitas hangus untuk satu booking.
    const select = { id: true, slotId: true, status: true, createdAt: true } as const;
    const existing = await tx.serviceSlotBooking.findUnique({
      where: { slotId_userId: { slotId, userId } },
      select: { id: true, status: true },
    });
    let booking: { id: string; slotId: string; status: SlotBookingStatus; createdAt: Date };
    if (existing) {
      // Hanya baris non-BOOKED yang bisa diklaim ulang — pemenang balapan
      // ditentukan oleh updateMany bersyarat (count 0 = sudah diklaim).
      const reclaimed = await tx.serviceSlotBooking.updateMany({
        where: { id: existing.id, status: { not: SlotBookingStatus.BOOKED } },
        data: { status: SlotBookingStatus.BOOKED, orderId: null },
      });
      if (reclaimed.count === 0) {
        throw new ConflictException({ code: ErrorCodes.SLOT_ALREADY_BOOKED, message: 'Kamu sudah booking slot ini' });
      }
      booking = { id: existing.id, slotId, status: SlotBookingStatus.BOOKED, createdAt: new Date() };
    } else {
      try {
        booking = await tx.serviceSlotBooking.create({
          data: { slotId, userId, status: SlotBookingStatus.BOOKED },
          select,
        });
      } catch (err) {
        // Unique (slotId, userId) → request paralel sudah membuat barisnya.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new ConflictException({ code: ErrorCodes.SLOT_ALREADY_BOOKED, message: 'Kamu sudah booking slot ini' });
        }
        throw err;
      }
    }
    const claimed = await tx.serviceSlot.updateMany({
      where: { id: slotId, bookedCount: { lt: capacity }, isActive: true },
      data: { bookedCount: { increment: 1 } },
    });
    if (claimed.count === 0) {
      // Melempar di dalam transaksi = baris booking di atas ikut dibatalkan.
      throw new ConflictException({ code: ErrorCodes.SLOT_FULL, message: 'Slot sudah penuh' });
    }
    return booking;
  }

  /**
   * P2-2: booking dengan order escrow tertaut TIDAK BOLEH dibatalkan
   * diam-diam. Sebelumnya `select` tidak membaca `orderId` sehingga slot
   * dibebaskan sementara dana escrow tetap terkunci di order (inkonsisten).
   * Sekarang: cascade via alur order resmi — order yang masih cancellable
   * dibatalkan dulu, baru slot dibebaskan. Order yang sudah tidak bisa
   * dibatalkan (PROCESSING+) → tolak dengan pesan yang jelas (fail closed).
   */
  async cancelBooking(userId: string, bookingId: string) {
    const booking = await this.prisma.serviceSlotBooking.findFirst({
      where: { id: bookingId, userId, status: SlotBookingStatus.BOOKED },
      select: { id: true, slotId: true, orderId: true },
    });
    if (!booking) throw new NotFoundException({ code: ErrorCodes.BOOKING_NOT_FOUND, message: 'Booking tidak ditemukan' });
    if (booking.orderId) {
      const order = await this.prisma.order.findUnique({
        where: { id: booking.orderId },
        select: { orderId: true, status: true },
      });
      const terminal = order && (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.COMPLETED);
      if (!terminal) {
        try {
          await this.orderStateService.cancelOrder(order!.orderId, userId, 'OTHER', 'Booking jasa dibatalkan buyer — cascade ke order');
        } catch (e) {
          throw new BadRequestException({
            code: ErrorCodes.INVALID_ORDER_STATUS,
            message: 'Booking memiliki order aktif yang tidak bisa dibatalkan — selesaikan/batalkan melalui alur order atau hubungi admin',
          });
        }
      }
    }
    await this.prisma.$transaction(async (tx) => {
      // BES-07 (audit etalase 2026-10-10): batal ganda (dua ketukan / dua
      // perangkat) tidak boleh mengurangi bookedCount dua kali — decrement
      // hanya bila transisi BOOKED→CANCELLED benar-benar terjadi di sini.
      const cancelled = await tx.serviceSlotBooking.updateMany({
        where: { id: booking.id, status: SlotBookingStatus.BOOKED },
        data: { status: SlotBookingStatus.CANCELLED },
      });
      if (cancelled.count === 1) {
        await tx.serviceSlot.updateMany({
          where: { id: booking.slotId, bookedCount: { gt: 0 } },
          data: { bookedCount: { decrement: 1 } },
        });
      }
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
            // BES-15: % dan _ dari input admin tidak boleh jadi wildcard LIKE.
            { username: { contains: escapeLikePattern(term), mode: 'insensitive' } },
            { fullName: { contains: escapeLikePattern(term), mode: 'insensitive' } },
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
