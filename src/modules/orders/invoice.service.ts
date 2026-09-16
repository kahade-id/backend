import { Injectable, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import * as ErrorCodes from '../../common/constants/error-codes';
import { toIdr } from '../../common/utils/currency.util';
import PDFDocument from 'pdfkit';

@Injectable()
export class InvoiceService {
  constructor(private prisma: PrismaService) {}

  private readonly logger = new Logger(InvoiceService.name);

  async getInvoiceData(orderId: string, userId: string): Promise<object> {
    const order = await this.prisma.order.findFirst({
      where: { orderId, deletedAt: null },
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

  // 20.2 PDF generation for invoices
  async generateInvoicePdf(orderId: string, userId: string): Promise<Buffer> {
    const data = await this.getInvoiceData(orderId, userId) as any;
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(20).text(`Invoice ${data.invoiceNumber}`, { align: 'center' });
      doc.moveDown();
      doc.fontSize(12).text(`Order: ${data.orderId}`);
      doc.text(`Date: ${data.orderDate}`);
      doc.text(`Status: ${data.status}`);
      doc.moveDown();
      doc.text(`Buyer: ${data.buyer.fullName} (${data.buyer.username})`);
      doc.text(`Seller: ${data.seller.fullName} (${data.seller.username})`);
      doc.moveDown();
      doc.text(`Item: ${data.items.title}`);
      doc.text(`Value: Rp ${data.items.orderValue}`);
      doc.moveDown();
      doc.text(`Fee: Rp ${data.fees.feeAmount} (${Number(data.fees.feeRate) * 100}%)`);
      doc.text(`Buyer Pay: Rp ${data.totals.buyerPayAmount}`);
      doc.text(`Seller Receive: Rp ${data.totals.sellerReceiveAmount}`);
      doc.moveDown();
      doc.fontSize(10).text(`${data.company.name} - ${data.company.address}`, { align: 'center' });
      doc.end();
    });
  }

  async generateDisputePdf(disputeId: string, userId: string): Promise<Buffer> {
    const dispute = await this.prisma.dispute.findFirst({
      where: { OR: [{ id: disputeId }, { disputeId }] },
      include: { order: { select: { orderId: true, title: true } } },
    });
    if (!dispute) throw new NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(20).text(`Dispute Report ${dispute.disputeId}`, { align: 'center' });
      doc.moveDown();
      doc.fontSize(12).text(`Order: ${dispute.order?.orderId ?? dispute.orderId}`);
      doc.text(`Status: ${dispute.status}`);
      doc.text(`Created: ${dispute.createdAt}`);
      doc.moveDown();
      doc.text(`Buyer Claim: ${dispute.buyerClaim ?? '-'}`);
      doc.text(`Seller Claim: ${dispute.sellerClaim ?? '-'}`);
      doc.moveDown();
      doc.text(`Resolved At: ${dispute.resolvedAt ?? '-'}`);
      doc.end();
    });
  }
}
