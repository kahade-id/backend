import { Injectable, NotFoundException, ForbiddenException, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AgreementStatus } from '@prisma/client';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { CreateAgreementDto } from '../dto/commerce.dto';

/**
 * BE-COMMERCE (2026-10-01) — item 11: SPK digital RINGAN per order.
 * Teks kesepakatan + persetujuan kedua pihak via tap. Bukan e-sign korporat:
 * persetujuan tercatat sebagai timestamp per pihak.
 * Alur: DRAFT (dibuat salah satu pihak) → WAITING_COUNTERPART → AGREED
 * (kedua pihak tap setuju).
 */
@Injectable()
export class AgreementsService {
  constructor(private prisma: PrismaService) {}

  private async assertPartyOrder(userId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { OR: [{ id: orderId }, { orderId }], deletedAt: null },
      select: { id: true, orderId: true, buyerId: true, sellerId: true },
    });
    if (!order) throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order tidak ditemukan' });
    if (order.buyerId !== userId && order.sellerId !== userId) {
      throw new ForbiddenException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Bukan pihak order ini' });
    }
    return order;
  }

  async createAgreement(userId: string, dto: CreateAgreementDto) {
    const order = await this.assertPartyOrder(userId, dto.orderId);
    const existing = await this.prisma.orderAgreement.findUnique({ where: { orderId: order.id } });
    if (existing) {
      throw new ConflictException({ code: ErrorCodes.AGREEMENT_ALREADY_EXISTS, message: 'Order ini sudah punya SPK' });
    }
    const isSeller = order.sellerId === userId;
    const now = new Date();
    return this.prisma.orderAgreement.create({
      data: {
        orderId: order.id,
        text: dto.text.trim(),
        status: AgreementStatus.WAITING_COUNTERPART,
        createdBy: userId,
        // Pembuat otomatis dianggap setuju (tap saat membuat).
        sellerAgreedAt: isSeller ? now : null,
        buyerAgreedAt: !isSeller ? now : null,
      },
    });
  }

  async getAgreement(userId: string, orderId: string) {
    const order = await this.assertPartyOrder(userId, orderId);
    const agreement = await this.prisma.orderAgreement.findUnique({ where: { orderId: order.id } });
    if (!agreement) throw new NotFoundException({ code: ErrorCodes.AGREEMENT_NOT_FOUND, message: 'SPK tidak ditemukan' });
    return { ...agreement, orderId: order.orderId };
  }

  /**
   * Tap setuju oleh pihak yang belum setuju. Bila kedua timestamp terisi →
   * status AGREED. Idempoten bila sudah AGREED oleh kedua pihak? Tidak —
   * tap ganda oleh pihak yang sama ditolak (fail closed).
   */
  async agree(userId: string, orderId: string) {
    const order = await this.assertPartyOrder(userId, orderId);
    const agreement = await this.prisma.orderAgreement.findUnique({ where: { orderId: order.id } });
    if (!agreement) throw new NotFoundException({ code: ErrorCodes.AGREEMENT_NOT_FOUND, message: 'SPK tidak ditemukan' });
    if (agreement.status === AgreementStatus.CANCELLED) {
      throw new BadRequestException({ code: ErrorCodes.AGREEMENT_INVALID_STATE, message: 'SPK sudah dibatalkan' });
    }
    if (agreement.status === AgreementStatus.AGREED) {
      return { ...agreement, orderId: order.orderId };
    }
    const isSeller = order.sellerId === userId;
    const field = isSeller ? 'sellerAgreedAt' : 'buyerAgreedAt';
    if (agreement[field] !== null) {
      throw new BadRequestException({ code: ErrorCodes.AGREEMENT_INVALID_STATE, message: 'Kamu sudah menyetujui SPK ini' });
    }
    const now = new Date();
    const sellerAgreedAt = isSeller ? now : agreement.sellerAgreedAt;
    const buyerAgreedAt = !isSeller ? now : agreement.buyerAgreedAt;
    const bothAgreed = sellerAgreedAt !== null && buyerAgreedAt !== null;
    const updated = await this.prisma.orderAgreement.update({
      where: { id: agreement.id },
      data: {
        [field]: now,
        status: bothAgreed ? AgreementStatus.AGREED : AgreementStatus.WAITING_COUNTERPART,
      },
    });
    return { ...updated, orderId: order.orderId };
  }

  async cancelAgreement(userId: string, orderId: string) {
    const order = await this.assertPartyOrder(userId, orderId);
    const agreement = await this.prisma.orderAgreement.findUnique({ where: { orderId: order.id } });
    if (!agreement) throw new NotFoundException({ code: ErrorCodes.AGREEMENT_NOT_FOUND, message: 'SPK tidak ditemukan' });
    if (agreement.status === AgreementStatus.AGREED) {
      throw new BadRequestException({ code: ErrorCodes.AGREEMENT_INVALID_STATE, message: 'SPK yang sudah disetujui tidak bisa dibatalkan' });
    }
    const updated = await this.prisma.orderAgreement.update({
      where: { id: agreement.id },
      data: { status: AgreementStatus.CANCELLED },
    });
    return { ...updated, orderId: order.orderId };
  }
}
