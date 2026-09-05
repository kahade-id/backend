import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import * as ErrorCodes from '../../common/constants/error-codes';
import { toIdr } from '../../common/utils/currency.util';

const OG_CACHE_TTL = 300;
const DEFAULT_OG_IMAGE = 'https://kahade.id/og-default.png';
const PUBLIC_WEB_BASE_URL = (process.env.PUBLIC_WEB_BASE_URL || 'https://kahade.id').replace(/\/$/, '');

@Injectable()
export class OgMetadataService {
  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  async getUserOgMetadata(username: string): Promise<object> {
    const cacheKey = `og:user:${username.toLowerCase()}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try { return JSON.parse(cached); } catch {}
    }

    const user = await this.prisma.user.findUnique({
      where: { username: username.toLowerCase() },
      select: {
        username: true,
        fullName: true,
        avatarUrl: true,
        bio: true,
        membershipRank: true,
        averageRating: true,
        totalRatingCount: true,
        totalOrdersCompleted: true,
        kycStatus: true,
        isVip: true,
        profileVisible: true,
      },
    });

    if (!user || !user.profileVisible) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }

    const resolvedUsername = user.username || username.toLowerCase();
    const title = `${user.fullName || resolvedUsername} - Kahade`;
    const description = user.bio || `${user.username} on Kahade. Rating: ${user.averageRating}/5 (${user.totalRatingCount} reviews). ${user.totalOrdersCompleted} completed orders.`;
    const image = user.avatarUrl || DEFAULT_OG_IMAGE;

    const result = {
      title,
      description,
      image,
      url: `${PUBLIC_WEB_BASE_URL}/u/${encodeURIComponent(resolvedUsername)}`,
      type: 'profile',
      meta: {
        'og:title': title,
        'og:description': description,
        'og:image': image,
        'og:type': 'profile',
        'og:url': `${PUBLIC_WEB_BASE_URL}/u/${encodeURIComponent(resolvedUsername)}`,
        'twitter:card': 'summary',
        'twitter:title': title,
        'twitter:description': description,
        'twitter:image': image,
      },
    };

    await this.redis.set(cacheKey, JSON.stringify(result), OG_CACHE_TTL);
    return result;
  }

  async invalidateUserOgCache(username: string): Promise<void> {
    const cacheKey = `og:user:${username.toLowerCase()}`;
    await this.redis.del(cacheKey);
  }

  async getOrderOgMetadata(orderId: string): Promise<object> {
    const cacheKey = `og:order:${orderId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try { return JSON.parse(cached); } catch {}
    }

    const order = await this.prisma.order.findFirst({
      where: { orderId },
      select: {
        orderId: true,
        title: true,
        description: true,
        orderType: true,
        orderValue: true,
        status: true,
        seller: { select: { username: true, fullName: true, avatarUrl: true } },
      },
    });

    if (!order) {
      throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
    }

    const title = `${order.title} - Kahade`;
    const description = `${order.orderType} order worth Rp ${toIdr(order.orderValue).toLocaleString('id-ID')} by ${order.seller.fullName || order.seller.username}`;
    const image = order.seller.avatarUrl || DEFAULT_OG_IMAGE;

    const result = {
      title,
      description,
      image,
      url: `${PUBLIC_WEB_BASE_URL}/o/${encodeURIComponent(order.orderId)}`,
      type: 'order',
      meta: {
        'og:title': title,
        'og:description': description,
        'og:image': image,
        'og:type': 'website',
        'og:url': `${PUBLIC_WEB_BASE_URL}/o/${encodeURIComponent(order.orderId)}`,
        'twitter:card': 'summary',
        'twitter:title': title,
        'twitter:description': description,
        'twitter:image': image,
      },
    };

    await this.redis.set(cacheKey, JSON.stringify(result), OG_CACHE_TTL);
    return result;
  }
}
