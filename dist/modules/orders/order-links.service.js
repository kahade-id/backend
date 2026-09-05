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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var OrderLinksService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrderLinksService = void 0;
const common_1 = require("@nestjs/common");
const crypto_1 = require("crypto");
const config_1 = require("@nestjs/config");
const client_1 = require("@prisma/client");
const prisma_service_1 = require("../../prisma/prisma.service");
const redis_service_1 = require("../../redis/redis.service");
const fee_calculator_service_1 = require("./fee-calculator.service");
const id_generator_util_1 = require("../../common/utils/id-generator.util");
const redis_keys_1 = require("../../common/constants/redis-keys");
const app_constants_1 = require("../../common/constants/app.constants");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const app_constants_2 = require("../../common/constants/app.constants");
const currency_util_1 = require("../../common/utils/currency.util");
const date_util_1 = require("../../common/utils/date.util");
const notification_queue_service_1 = require("../queue/notification-queue.service");
let OrderLinksService = OrderLinksService_1 = class OrderLinksService {
    constructor(prisma, redis, feeCalculator, notificationQueue, configService) {
        this.prisma = prisma;
        this.redis = redis;
        this.feeCalculator = feeCalculator;
        this.notificationQueue = notificationQueue;
        this.configService = configService;
        this.logger = new common_1.Logger(OrderLinksService_1.name);
    }
    isRetryableDbError(err) {
        if (err instanceof client_1.Prisma.PrismaClientKnownRequestError && err.code === 'P2034')
            return true;
        if (err instanceof client_1.Prisma.PrismaClientUnknownRequestError) {
            const msg = err.message.toLowerCase();
            if (msg.includes('40001') || msg.includes('serialization') || msg.includes('40p01') || msg.includes('deadlock'))
                return true;
        }
        return false;
    }
    getShareUrl(token) {
        const base = (this.configService?.get('app.publicWebBaseUrl') ?? process.env.PUBLIC_WEB_BASE_URL ?? 'https://kahade.id').replace(/\/$/, '');
        return `${base}/o-l/${encodeURIComponent(token)}`;
    }
    async getNextLinkSerial() {
        const today = (0, date_util_1.formatWIBDate)().replace(/-/g, '');
        const key = (0, redis_keys_1.ORDER_LINK_SERIAL)(today);
        const redisClient = this.redis.getClient();
        const redisKey = `${this.redis.getPrefix()}${key}`;
        const atomicScript = `
      local current = redis.call("INCR", KEYS[1])
      if current == 1 then
        redis.call("EXPIRE", KEYS[1], ARGV[1])
      end
      return current
    `;
        return await redisClient.eval(atomicScript, 1, redisKey, (2 * 24 * 3600).toString());
    }
    async getNextOrderSerial() {
        const today = (0, date_util_1.formatWIBDate)().replace(/-/g, '');
        const key = (0, redis_keys_1.ORDER_SERIAL)(today);
        const redisClient = this.redis.getClient();
        const redisKey = `${this.redis.getPrefix()}${key}`;
        const atomicScript = `
      local current = redis.call("INCR", KEYS[1])
      if current == 1 then
        redis.call("EXPIRE", KEYS[1], ARGV[1])
      end
      return current
    `;
        return await redisClient.eval(atomicScript, 1, redisKey, (2 * 24 * 3600).toString());
    }
    async createLink(userId, dto) {
        if (!Number.isSafeInteger(dto.orderValue) || dto.orderValue < app_constants_1.ORDER_MIN_VALUE || dto.orderValue > app_constants_1.ORDER_MAX_VALUE) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `Order value must be an integer between Rp ${app_constants_1.ORDER_MIN_VALUE.toLocaleString('id-ID')} and Rp ${app_constants_1.ORDER_MAX_VALUE.toLocaleString('id-ID')}` });
        }
        const creator = await this.prisma.user.findUnique({ where: { id: userId }, select: { isActive: true, isBanned: true } });
        if (!creator)
            throw new common_1.NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
        if (!creator.isActive || creator.isBanned)
            throw new common_1.ForbiddenException({ code: ErrorCodes.COUNTERPART_SUSPENDED, message: 'Your account is suspended' });
        const sanitizedTitle = (typeof dto.title === 'string' ? dto.title : '').replace(/[<>"'&]/g, '').trim();
        const sanitizedDescription = (typeof dto.description === 'string' ? dto.description : '').replace(/[<>"'&]/g, '').trim();
        if (sanitizedTitle.length < 3 || sanitizedTitle.length > 100 || sanitizedDescription.length < 10 || sanitizedDescription.length > 500) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Link title must be 3–100 characters and description 10–500 characters after sanitization' });
        }
        if (!Number.isSafeInteger(dto.deliveryDeadlineDays) || dto.deliveryDeadlineDays < app_constants_1.DELIVERY_DEADLINE_DAYS_MIN || dto.deliveryDeadlineDays > app_constants_1.DELIVERY_DEADLINE_DAYS_MAX) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `Delivery deadline must be an integer between ${app_constants_1.DELIVERY_DEADLINE_DAYS_MIN} and ${app_constants_1.DELIVERY_DEADLINE_DAYS_MAX} days` });
        }
        const normalizedCounterpartUsername = dto.counterpartUsername?.trim().toLowerCase();
        if (normalizedCounterpartUsername && (normalizedCounterpartUsername.length < 3 || normalizedCounterpartUsername.length > 50)) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Counterpart username must be between 3 and 50 characters' });
        }
        const serial = await this.getNextLinkSerial();
        const linkId = (0, id_generator_util_1.generateOrderLinkId)(serial);
        const token = (0, id_generator_util_1.generateOrderLinkToken)();
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + app_constants_2.ORDER_LINK_EXPIRY_HOURS);
        const link = await this.prisma.orderLink.create({
            data: {
                linkId,
                token,
                creatorId: userId,
                creatorRole: dto.role,
                title: sanitizedTitle,
                description: sanitizedDescription,
                orderType: dto.orderType,
                orderValue: BigInt(dto.orderValue) * 100n,
                feeResponsibility: dto.feeResponsibility,
                deliveryDeadlineDays: dto.deliveryDeadlineDays,
                counterpartUsername: normalizedCounterpartUsername,
                expiresAt,
            },
        });
        return {
            linkId: link.linkId,
            token: link.token,
            expiresAt: link.expiresAt,
            shareUrl: this.getShareUrl(link.token),
        };
    }
    async getLinkByToken(token) {
        const link = await this.prisma.orderLink.findUnique({
            where: { token },
            include: {
                creator: {
                    select: { userId: true, username: true, fullName: true, avatarUrl: true, membershipRank: true, averageRating: true, totalRatingCount: true, kycStatus: true },
                },
            },
        });
        if (!link) {
            throw new common_1.NotFoundException({ code: ErrorCodes.ORDER_LINK_NOT_FOUND, message: 'Order link not found' });
        }
        if (link.status === 'ACCEPTED' || link.status === 'CANCELLED') {
            throw new common_1.BadRequestException({ code: ErrorCodes.ORDER_LINK_ALREADY_USED, message: 'Order link is no longer available' });
        }
        if (link.status === 'EXPIRED' || link.expiresAt <= new Date()) {
            if (link.status === 'ACTIVE') {
                await this.prisma.orderLink.updateMany({ where: { id: link.id, status: 'ACTIVE' }, data: { status: 'EXPIRED' } });
            }
            throw new common_1.BadRequestException({ code: ErrorCodes.ORDER_LINK_EXPIRED, message: 'Order link has expired' });
        }
        return {
            linkId: link.linkId,
            token: link.token,
            creator: {
                userId: link.creator.userId,
                username: link.creator.username,
                fullName: link.creator.fullName,
                avatarUrl: link.creator.avatarUrl,
                membershipRank: link.creator.membershipRank,
                avgRating: link.creator.averageRating,
                ratingCount: link.creator.totalRatingCount,
                isKycVerified: link.creator.kycStatus === 'APPROVED',
            },
            creatorRole: link.creatorRole,
            title: link.title,
            description: link.description,
            orderType: link.orderType,
            orderValue: (0, currency_util_1.toIdr)(link.orderValue),
            feeResponsibility: link.feeResponsibility,
            deliveryDeadlineDays: link.deliveryDeadlineDays,
            counterpartUsername: link.counterpartUsername,
            expiresAt: link.expiresAt,
            status: link.status,
        };
    }
    async acceptLink(token, userId) {
        const link = await this.prisma.orderLink.findUnique({ where: { token } });
        if (!link) {
            throw new common_1.NotFoundException({ code: ErrorCodes.ORDER_LINK_NOT_FOUND, message: 'Order link not found' });
        }
        if (link.creatorId === userId) {
            throw new common_1.BadRequestException({ code: ErrorCodes.ORDER_LINK_OWN, message: 'Cannot accept your own order link' });
        }
        if (link.status !== 'ACTIVE') {
            throw new common_1.BadRequestException({ code: ErrorCodes.ORDER_LINK_ALREADY_USED, message: 'Order link is no longer active' });
        }
        if (link.expiresAt < new Date()) {
            await this.prisma.orderLink.update({ where: { id: link.id }, data: { status: 'EXPIRED' } });
            throw new common_1.BadRequestException({ code: ErrorCodes.ORDER_LINK_EXPIRED, message: 'Order link has expired' });
        }
        if (link.counterpartUsername) {
            const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { username: true } });
            if (user?.username?.toLowerCase() !== link.counterpartUsername) {
                throw new common_1.ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'This link is intended for a specific user' });
            }
        }
        const blocked = await this.prisma.blockList.findFirst({
            where: {
                OR: [
                    { blockerId: link.creatorId, blockedId: userId },
                    { blockerId: userId, blockedId: link.creatorId },
                ],
            },
        });
        if (blocked) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.USER_BLOCKED, message: 'Cannot accept order from blocked user' });
        }
        const buyerId = link.creatorRole === 'SELLER' ? userId : link.creatorId;
        const sellerId = link.creatorRole === 'SELLER' ? link.creatorId : userId;
        const orderValueIdr = (0, currency_util_1.toIdr)(link.orderValue);
        const [buyer, seller, acceptingUser] = await Promise.all([
            this.prisma.user.findUnique({ where: { id: buyerId }, select: { kycStatus: true, isKahadePlus: true, isActive: true, isBanned: true } }),
            this.prisma.user.findUnique({ where: { id: sellerId }, select: { kycStatus: true, isActive: true, isBanned: true } }),
            this.prisma.user.findUnique({ where: { id: userId }, select: { isActive: true, isBanned: true } }),
        ]);
        if (!acceptingUser || !acceptingUser.isActive || acceptingUser.isBanned) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.COUNTERPART_SUSPENDED, message: 'Your account is suspended' });
        }
        const counterpartUser = link.creatorId === buyerId ? buyer : seller;
        if (!counterpartUser || !counterpartUser.isActive || counterpartUser.isBanned) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.COUNTERPART_SUSPENDED, message: 'The order link creator account is suspended' });
        }
        if (orderValueIdr >= app_constants_1.KYC_THRESHOLD) {
            if (buyer?.kycStatus !== client_1.KycStatus.APPROVED) {
                throw new common_1.ForbiddenException({ code: ErrorCodes.KYC_REQUIRED, message: 'KYC verification required for high-value orders (buyer)' });
            }
            if (seller?.kycStatus !== client_1.KycStatus.APPROVED) {
                throw new common_1.ForbiddenException({ code: ErrorCodes.KYC_REQUIRED, message: 'KYC verification required for high-value orders (seller)' });
            }
        }
        const feeConfig = await this.feeCalculator.getFeeConfig();
        let kahadePlusApplied = false;
        if (buyer?.isKahadePlus) {
            const activeSubscription = await this.prisma.subscription.findFirst({
                where: {
                    userId: buyerId,
                    status: { in: [client_1.SubscriptionStatus.ACTIVE, client_1.SubscriptionStatus.CANCELLED] },
                    currentPeriodEnd: { gt: new Date() },
                },
                select: { feeSavingsUsed: true, feeSavingsLimit: true },
            });
            kahadePlusApplied = Boolean(activeSubscription && activeSubscription.feeSavingsUsed < activeSubscription.feeSavingsLimit);
        }
        const feeResult = this.feeCalculator.calculateFee({
            orderValue: orderValueIdr,
            feeResponsibility: link.feeResponsibility,
            isKahadePlus: kahadePlusApplied,
        }, feeConfig);
        const orderSerial = await this.getNextOrderSerial();
        const orderId = (0, id_generator_util_1.generateOrderId)(orderSerial);
        const MAX_RETRIES = 3;
        let result;
        let lastError = null;
        const runTx = () => this.prisma.$transaction(async (tx) => {
            const freshLink = await tx.orderLink.findUnique({ where: { id: link.id } });
            if (!freshLink || freshLink.status !== 'ACTIVE') {
                throw new common_1.ConflictException({ code: ErrorCodes.ORDER_LINK_ALREADY_USED, message: 'Order link was already accepted or is no longer active' });
            }
            if (freshLink.expiresAt <= new Date()) {
                await tx.orderLink.updateMany({ where: { id: link.id, status: 'ACTIVE' }, data: { status: 'EXPIRED' } });
                throw new common_1.BadRequestException({ code: ErrorCodes.ORDER_LINK_EXPIRED, message: 'Order link has expired' });
            }
            const [freshAcceptingUser, freshBuyer, freshSeller] = await Promise.all([
                tx.user.findUnique({ where: { id: userId }, select: { isActive: true, isBanned: true, username: true } }),
                tx.user.findUnique({ where: { id: buyerId }, select: { kycStatus: true, isActive: true, isBanned: true } }),
                tx.user.findUnique({ where: { id: sellerId }, select: { kycStatus: true, isActive: true, isBanned: true } }),
            ]);
            if (!freshAcceptingUser || !freshAcceptingUser.isActive || freshAcceptingUser.isBanned) {
                throw new common_1.ForbiddenException({ code: ErrorCodes.COUNTERPART_SUSPENDED, message: 'Your account is suspended' });
            }
            if (!freshBuyer || !freshSeller || !freshBuyer.isActive || freshBuyer.isBanned || !freshSeller.isActive || freshSeller.isBanned) {
                throw new common_1.ForbiddenException({ code: ErrorCodes.COUNTERPART_SUSPENDED, message: 'A participant account is suspended' });
            }
            if (freshLink.counterpartUsername && freshAcceptingUser.username?.toLowerCase() !== freshLink.counterpartUsername) {
                throw new common_1.ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'This link is intended for a specific user' });
            }
            const freshBlocked = await tx.blockList.findFirst({
                where: {
                    OR: [
                        { blockerId: freshLink.creatorId, blockedId: userId },
                        { blockerId: userId, blockedId: freshLink.creatorId },
                    ],
                },
                select: { id: true },
            });
            if (freshBlocked)
                throw new common_1.ForbiddenException({ code: ErrorCodes.USER_BLOCKED, message: 'Cannot accept order from blocked user' });
            if (orderValueIdr >= app_constants_1.KYC_THRESHOLD && (freshBuyer.kycStatus !== client_1.KycStatus.APPROVED || freshSeller.kycStatus !== client_1.KycStatus.APPROVED)) {
                throw new common_1.ForbiddenException({ code: ErrorCodes.KYC_REQUIRED, message: 'KYC verification required for high-value orders' });
            }
            const linkUpdated = await tx.orderLink.updateMany({
                where: { id: link.id, status: 'ACTIVE' },
                data: { status: 'ACCEPTED', acceptedAt: new Date(), acceptedById: userId },
            });
            if (linkUpdated.count === 0) {
                throw new common_1.ConflictException({ code: ErrorCodes.ORDER_LINK_ALREADY_USED, message: 'Order link was already accepted or is no longer active' });
            }
            const order = await tx.order.create({
                data: {
                    orderId,
                    buyerId,
                    sellerId,
                    title: link.title,
                    description: link.description,
                    orderType: link.orderType,
                    orderValue: link.orderValue,
                    feeAmount: feeResult.feeAmount,
                    feeResponsibility: link.feeResponsibility,
                    buyerFeeAmount: feeResult.buyerFeeAmount,
                    sellerFeeAmount: feeResult.sellerFeeAmount,
                    buyerPayAmount: feeResult.buyerPayAmount,
                    sellerReceiveAmount: feeResult.sellerReceiveAmount,
                    voucherDiscount: feeResult.voucherDiscount,
                    feeRate: feeResult.feeRate,
                    isKahadePlus: kahadePlusApplied,
                    deliveryDeadlineDays: link.deliveryDeadlineDays,
                    createdByBuyer: link.creatorRole === 'BUYER',
                    status: 'WAITING_CONFIRMATION',
                    orderLinkId: link.id,
                    confirmationDeadlineAt: (0, date_util_1.toWIB)().add(app_constants_1.CONFIRMATION_DEADLINE_DAYS_MAP[link.orderType] ?? 3, 'day').toDate(),
                },
            });
            await tx.chatRoom.create({ data: { orderId: order.id } });
            await tx.orderStatusHistory.create({
                data: {
                    orderId: order.id,
                    fromStatus: 'WAITING_CONFIRMATION',
                    toStatus: 'WAITING_CONFIRMATION',
                    changedBy: userId,
                    changedByType: link.creatorRole === 'SELLER' ? 'BUYER' : 'SELLER',
                    reason: 'Order created via order link',
                },
            });
            return { order, creatorId: link.creatorRole === 'BUYER' ? buyerId : sellerId };
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                result = await runTx();
                lastError = null;
                break;
            }
            catch (err) {
                lastError = err;
                if (!this.isRetryableDbError(err) || attempt === MAX_RETRIES) {
                    this.logger.error(`ACCEPT_LINK_TX_FAILED token=${link.linkId} attempt=${attempt}/${MAX_RETRIES}`, err instanceof Error ? err.stack : String(err));
                    break;
                }
                this.logger.warn(`ACCEPT_LINK_TX_RETRY token=${link.linkId} attempt=${attempt}/${MAX_RETRIES}`);
                const jitter = (0, crypto_1.randomInt)(0, 50);
                await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt - 1) + jitter));
            }
        }
        if (lastError)
            throw lastError;
        if (!result)
            throw new common_1.ConflictException({ code: ErrorCodes.ORDER_LINK_ALREADY_USED, message: 'Order link could not be accepted' });
        void this.notificationQueue.enqueue({
            userId: result.creatorId,
            type: client_1.NotificationType.ORDER_NEW,
            title: 'Order Link Accepted',
            body: `Your order link "${link.title}" has been accepted. A new order has been created.`,
            pushData: { type: 'ORDER_NEW', orderId: result.order.orderId },
            actionUrl: `/o/${result.order.orderId}`,
        }).catch((error) => this.logger.warn(`ACCEPT_LINK notification failed: ${error instanceof Error ? error.message : String(error)}`));
        return {
            orderId: result.order.orderId,
            status: result.order.status,
        };
    }
    async getMyLinks(userId, page, limit) {
        const safePage = Math.max(1, Math.trunc(Number.isFinite(page) ? page : 1));
        const safeLimit = Math.min(50, Math.max(1, Math.trunc(Number.isFinite(limit) ? limit : 20)));
        const skip = (safePage - 1) * safeLimit;
        const [links, total] = await Promise.all([
            this.prisma.orderLink.findMany({
                where: { creatorId: userId },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                skip,
                take: safeLimit,
            }),
            this.prisma.orderLink.count({ where: { creatorId: userId } }),
        ]);
        return {
            data: links.map(l => ({
                linkId: l.linkId,
                token: l.token,
                title: l.title,
                description: l.description,
                orderType: l.orderType,
                orderValue: (0, currency_util_1.toIdr)(l.orderValue),
                status: l.status,
                creatorRole: l.creatorRole,
                counterpartUsername: l.counterpartUsername,
                shareUrl: this.getShareUrl(l.token),
                expiresAt: l.expiresAt,
                createdAt: l.createdAt,
            })),
            total,
            page: safePage,
            limit: safeLimit,
            totalPages: Math.ceil(total / safeLimit),
        };
    }
    async cancelLink(token, userId) {
        const preflightLink = await this.prisma.orderLink.findUnique({ where: { token } });
        if (!preflightLink)
            throw new common_1.NotFoundException({ code: ErrorCodes.ORDER_LINK_NOT_FOUND, message: 'Order link not found' });
        if (preflightLink.creatorId !== userId)
            throw new common_1.ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Not your link' });
        if (preflightLink.status !== 'ACTIVE')
            throw new common_1.BadRequestException({ code: ErrorCodes.ORDER_LINK_ALREADY_USED, message: 'Link is no longer active' });
        if (preflightLink.expiresAt <= new Date()) {
            await this.prisma.orderLink.updateMany({ where: { id: preflightLink.id, status: 'ACTIVE' }, data: { status: 'EXPIRED' } });
            throw new common_1.BadRequestException({ code: ErrorCodes.ORDER_LINK_EXPIRED, message: 'Order link has expired' });
        }
        const maxRetries = 3;
        let lastError;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await this.prisma.$transaction(async (tx) => {
                    const link = await tx.orderLink.findUnique({ where: { token } });
                    if (!link)
                        throw new common_1.NotFoundException({ code: ErrorCodes.ORDER_LINK_NOT_FOUND, message: 'Order link not found' });
                    if (link.creatorId !== userId)
                        throw new common_1.ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Not your link' });
                    const creator = await tx.user.findUnique({ where: { id: userId }, select: { isActive: true, isBanned: true } });
                    if (!creator || !creator.isActive || creator.isBanned) {
                        throw new common_1.ForbiddenException({ code: ErrorCodes.COUNTERPART_SUSPENDED, message: 'Your account is suspended' });
                    }
                    if (link.status !== 'ACTIVE')
                        throw new common_1.BadRequestException({ code: ErrorCodes.ORDER_LINK_ALREADY_USED, message: 'Link is no longer active' });
                    const now = new Date();
                    if (link.expiresAt <= now) {
                        await tx.orderLink.updateMany({ where: { id: link.id, status: 'ACTIVE' }, data: { status: 'EXPIRED' } });
                        throw new common_1.BadRequestException({ code: ErrorCodes.ORDER_LINK_EXPIRED, message: 'Order link has expired' });
                    }
                    const updated = await tx.orderLink.updateMany({
                        where: { id: link.id, status: 'ACTIVE', expiresAt: { gt: now } },
                        data: { status: 'CANCELLED' },
                    });
                    if (updated.count === 0) {
                        throw new common_1.ConflictException({ code: ErrorCodes.ORDER_LINK_ALREADY_USED, message: 'Link status has already changed' });
                    }
                }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
                return { message: 'Order link cancelled' };
            }
            catch (error) {
                lastError = error;
                if (!this.isRetryableDbError(error) || attempt === maxRetries)
                    throw error;
                this.logger.warn(`CANCEL_LINK_TX_RETRY token=${token} attempt=${attempt}/${maxRetries}`);
                await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt - 1) + (0, crypto_1.randomInt)(0, 50)));
            }
        }
        throw lastError ?? new common_1.ConflictException({ code: ErrorCodes.ORDER_LINK_ALREADY_USED, message: 'Link could not be cancelled' });
    }
};
exports.OrderLinksService = OrderLinksService;
exports.OrderLinksService = OrderLinksService = OrderLinksService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(4, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService,
        fee_calculator_service_1.FeeCalculatorService,
        notification_queue_service_1.NotificationQueueService,
        config_1.ConfigService])
], OrderLinksService);
