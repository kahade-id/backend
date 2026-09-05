import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import * as ErrorCodes from '../../common/constants/error-codes';
import { toIdr } from '../../common/utils/currency.util';

@Injectable()
export class InvoiceService {
  constructor(private prisma: PrismaService) {}

  async getInvoiceData(orderId: string, userId: string): Promise<object> {
    const order = await this.prisma.order.findFirst({
      where: { orderId },
      include: {
        buyer: { select: { userId: true, fullName: true, username: true } },
        seller: { select: { userId: true, fullName: true, username: true } },
        voucher: { select: { code: true, name: true } },
      },
    });

    if (!order) throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
    if (order.buyerId !== userId && order.sellerId !== userId) {
      throw new ForbiddenException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Not a participant' });
    }

    if (order.status === 'WAITING_CONFIRMATION' || order.status === 'CANCELLED') {
      throw new ForbiddenException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Invoice not available for this status' });
    }

    return {
      invoiceNumber: `INV-${order.orderId}`,
      orderId: order.orderId,
      orderDate: order.createdAt,
      paidAt: order.paidAt,
      completedAt: order.completedAt,
      status: order.status,
      buyer: {
        userId: order.buyer.userId,
        fullName: order.buyer.fullName,
        username: order.buyer.username,
      },
      seller: {
        userId: order.seller.userId,
        fullName: order.seller.fullName,
        username: order.seller.username,
      },
      items: {
        title: order.title,
        description: order.description,
        orderType: order.orderType,
        orderValue: toIdr(order.orderValue),
      },
      fees: {
        feeRate: Number(order.feeRate),
        feeAmount: toIdr(order.feeAmount),
        feeResponsibility: order.feeResponsibility,
        buyerFeeAmount: toIdr(order.buyerFeeAmount),
        sellerFeeAmount: toIdr(order.sellerFeeAmount),
        voucherDiscount: toIdr(order.voucherDiscount),
        voucherCode: order.voucher?.code || null,
      },
      totals: {
        buyerPayAmount: toIdr(order.buyerPayAmount),
        sellerReceiveAmount: toIdr(order.sellerReceiveAmount),
      },
      company: {
        name: 'PT Kahade Digital Indonesia',
        address: 'Jakarta, Indonesia',
      },
    };
  }
}
