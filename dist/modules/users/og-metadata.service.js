"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OgMetadataService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const redis_service_1 = require("../../redis/redis.service");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const currency_util_1 = require("../../common/utils/currency.util");
const OG_CACHE_TTL = 300;
const DEFAULT_OG_IMAGE = 'https://kahade.id/og-default.png';
const PUBLIC_WEB_BASE_URL = (process.env.PUBLIC_WEB_BASE_URL || 'https://kahade.id').replace(/\/$/, '');
let OgMetadataService = class OgMetadataService {
    constructor(prisma, redis) {
        this.prisma = prisma;
        this.redis = redis;
    }
    async getUserOgMetadata(username) {
        const cacheKey = `og:user:${username.toLowerCase()}`;
        const cached = await this.redis.get(cacheKey);
        if (cached) {
            try {
                return JSON.parse(cached);
            }
            catch { }
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
            throw new common_1.NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
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
    async invalidateUserOgCache(username) {
        const cacheKey = `og:user:${username.toLowerCase()}`;
        await this.redis.del(cacheKey);
    }
    async getOrderOgMetadata(orderId) {
        const cacheKey = `og:order:${orderId}`;
        const cached = await this.redis.get(cacheKey);
        if (cached) {
            try {
                return JSON.parse(cached);
            }
            catch { }
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
            throw new common_1.NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
        }
        const title = `${order.title} - Kahade`;
        const description = `${order.orderType} order worth Rp ${(0, currency_util_1.toIdr)(order.orderValue).toLocaleString('id-ID')} by ${order.seller.fullName || order.seller.username}`;
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
};
exports.OgMetadataService = OgMetadataService;
exports.OgMetadataService = OgMetadataService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService])
], OgMetadataService);
