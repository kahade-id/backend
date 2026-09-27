// GAP-F (G454): partner-facing read API. Strict whitelist: only orders where
// the client is a party (buyer or seller via ownerUserId), and only whitelisted
// fields. NO full PII (no phone/email/PIN), no other users' balances.

import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PartnerRequestIdentity } from './partner.decorators';

interface OrderRow {
  orderId: string;
  title: string;
  status: string;
  orderType: string;
  orderValue: bigint | number | string;
  buyerPayAmount: bigint | number | string;
  sellerReceiveAmount: bigint | number | string;
  buyerId: string;
  sellerId: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

interface PartnerOrderPrisma {
  apiClient: { findUnique(args: unknown): Promise<{ ownerUserId: string | null } | null> };
  order: { findUnique(args: unknown): Promise<OrderRow | null> };
}

@Injectable()
export class PartnerApiService {
  constructor(private readonly prisma: PrismaService) {}

  private get p(): PartnerOrderPrisma {
    return this.prisma as unknown as PartnerOrderPrisma;
  }

  /**
   * GET /v1/partner/orders/:publicId — scoped to orders related to the client.
   * A client is "related" when its ownerUserId is the buyer or the seller.
   * Clients without ownerUserId see nothing (fail-closed).
   */
  async getOrder(publicId: string, partner: PartnerRequestIdentity): Promise<Record<string, unknown>> {
    const client = await this.p.apiClient.findUnique({ where: { id: partner.clientId } });
    const ownerUserId = client?.ownerUserId;
    if (!ownerUserId) {
      throw new ForbiddenException({
        code: 'PARTNER_ORDER_SCOPE_DENIED',
        message: 'Client ini tidak terikat ke akun merchant — tidak ada order yang dapat diakses',
      });
    }

    const order = await this.p.order.findUnique({ where: { orderId: publicId } });
    if (!order) {
      throw new NotFoundException({ code: 'PARTNER_ORDER_NOT_FOUND', message: 'Order tidak ditemukan' });
    }
    if (order.buyerId !== ownerUserId && order.sellerId !== ownerUserId) {
      // 404 (not 403) to avoid leaking existence of unrelated orders.
      throw new NotFoundException({ code: 'PARTNER_ORDER_NOT_FOUND', message: 'Order tidak ditemukan' });
    }

    const role = order.sellerId === ownerUserId ? 'seller' : 'buyer';
    return {
      version: '1.0',
      orderId: order.orderId,
      title: order.title,
      orderType: order.orderType,
      status: order.status,
      myRole: role,
      amounts: {
        orderValue: order.orderValue.toString(),
        buyerPayAmount: order.buyerPayAmount.toString(),
        sellerReceiveAmount: order.sellerReceiveAmount.toString(),
        currency: 'IDR',
      },
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
      completedAt: order.completedAt ? order.completedAt.toISOString() : null,
    };
  }

  /** GET /v1/partner/webhooks/health (G473): subscription + endpoint status. */
  async webhookHealth(partner: PartnerRequestIdentity): Promise<Record<string, unknown>> {
    const p = this.prisma as unknown as {
      partnerWebhookEndpoint: {
        findMany(args: unknown): Promise<Array<Record<string, unknown>>>;
      };
    };
    const endpoints = await p.partnerWebhookEndpoint.findMany({
      where: { clientId: partner.clientId },
      orderBy: { createdAt: 'desc' },
    });
    return {
      version: '1.0',
      clientId: partner.clientId,
      isSandbox: partner.isSandbox,
      endpoints: endpoints.map((e) => ({
        id: e['id'],
        url: e['url'],
        events: e['events'],
        isActive: e['isActive'],
        verifiedAt: e['verifiedAt'],
        lastDeliveryAt: e['lastDeliveryAt'] ?? null,
        lastDeliveryStatus: e['lastDeliveryStatus'] ?? null,
      })),
    };
  }

  /** Synthetic sandbox data — never touches production rows (G458). */
  sandboxOrder(publicId: string): Record<string, unknown> {
    return {
      version: '1.0',
      sandbox: true,
      orderId: publicId,
      title: '[SANDBOX] Contoh Order Sintetis',
      orderType: 'GOODS',
      status: 'COMPLETED',
      myRole: 'seller',
      amounts: {
        orderValue: '15000000',
        buyerPayAmount: '15375000',
        sellerReceiveAmount: '14625000',
        currency: 'IDR',
      },
      createdAt: new Date('2026-01-05T08:00:00.000Z').toISOString(),
      updatedAt: new Date('2026-01-06T10:30:00.000Z').toISOString(),
      completedAt: new Date('2026-01-06T10:30:00.000Z').toISOString(),
      note: 'Data sintetis sandbox — bukan data produksi.',
    };
  }
}
