import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { Prisma, ProductType, SlotBookingStatus } from '@prisma/client';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { createPaginatedResponse, PaginatedResponse } from '../../../common/dto/pagination.dto';
import { CreateServiceSlotDto } from '../dto/commerce.dto';

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * BE-COMMERCE (2026-10-01) — item 10: booking jasa via kalender.
 * Slot ketersediaan per produk JASA; buyer booking slot (kapasitas terbatas).
 */
@Injectable()
export class ServiceBookingService {
  constructor(private prisma: PrismaService) {}

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
    const slot = await this.prisma.serviceSlot.findFirst({
      where: { id: slotId, isActive: true },
      select: { id: true, sellerId: true, capacity: true, bookedCount: true },
    });
    if (!slot) throw new NotFoundException({ code: ErrorCodes.SLOT_NOT_FOUND, message: 'Slot tidak ditemukan / tidak aktif' });
    if (slot.sellerId === userId) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Seller tidak bisa booking slot sendiri' });
    }
    const dup = await this.prisma.serviceSlotBooking.findUnique({
      where: { slotId_userId: { slotId: slot.id, userId } },
      select: { id: true, status: true },
    });
    if (dup && dup.status === SlotBookingStatus.BOOKED) {
      throw new ConflictException({ code: ErrorCodes.SLOT_ALREADY_BOOKED, message: 'Kamu sudah booking slot ini' });
    }

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.serviceSlot.updateMany({
        where: { id: slot.id, bookedCount: { lt: slot.capacity }, isActive: true },
        data: { bookedCount: { increment: 1 } },
      });
      if (claimed.count === 0) {
        throw new ConflictException({ code: ErrorCodes.SLOT_FULL, message: 'Slot sudah penuh' });
      }
      const booking = await tx.serviceSlotBooking.upsert({
        where: { slotId_userId: { slotId: slot.id, userId } },
        create: { slotId: slot.id, userId, status: SlotBookingStatus.BOOKED },
        update: { status: SlotBookingStatus.BOOKED },
        select: { id: true, slotId: true, status: true, createdAt: true },
      });
      return booking;
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
}
