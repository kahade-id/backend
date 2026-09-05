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
var OrdersService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrdersService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const prisma_service_1 = require("../../prisma/prisma.service");
const redis_service_1 = require("../../redis/redis.service");
const realtime_service_1 = require("../realtime/realtime.service");
const fee_calculator_service_1 = require("./fee-calculator.service");
const client_1 = require("@prisma/client");
const id_generator_util_1 = require("../../common/utils/id-generator.util");
const currency_util_1 = require("../../common/utils/currency.util");
const bigint_util_1 = require("../../common/utils/bigint.util");
const date_util_1 = require("../../common/utils/date.util");
const redis_keys_1 = require("../../common/constants/redis-keys");
const notification_queue_service_1 = require("../queue/notification-queue.service");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const app_constants_1 = require("../../common/constants/app.constants");
function escapeLikePattern(pattern) {
    return pattern.replace(/[%_\\]/g, '\\$&');
}
const ORDER_COUNTERPART_COOLDOWN_SECONDS = 60;
function getConfirmationDeadlineDays(orderType) {
    return app_constants_1.CONFIRMATION_DEADLINE_DAYS_MAP[orderType] ?? app_constants_1.CONFIRMATION_DEADLINE_DAYS;
}
const ORDER_CREATE_MAX_RETRIES = 3;
const ORDER_TRANSITION_MAX_RETRIES = 3;
let OrdersService = OrdersService_1 = class OrdersService {
    constructor(prisma, redis, realtime, feeCalculator, configService, notificationQueue) {
        this.prisma = prisma;
        this.redis = redis;
        this.realtime = realtime;
        this.feeCalculator = feeCalculator;
        this.configService = configService;
        this.notificationQueue = notificationQueue;
        this.logger = new common_1.Logger(OrdersService_1.name);
        this.configuredMinOrderValue = this.configService.get('app.orderMinValue') ?? app_constants_1.ORDER_MIN_VALUE;
        this.configuredMaxOrderValue = this.configService.get('app.orderMaxValue') ?? app_constants_1.ORDER_MAX_VALUE;
    }
    isRetryableDbError(error) {
        if (error instanceof client_1.Prisma.PrismaClientKnownRequestError && error.code === 'P2034')
            return true;
        if (error instanceof client_1.Prisma.PrismaClientUnknownRequestError) {
            const message = error.message.toLowerCase();
            return message.includes('40001') || message.includes('serialization') || message.includes('40p01') || message.includes('deadlock');
        }
        return false;
    }
    async withSerializableRetry(operation, label) {
        for (let attempt = 1; attempt <= ORDER_TRANSITION_MAX_RETRIES; attempt++) {
            try {
                return await operation();
            }
            catch (error) {
                if (!this.isRetryableDbError(error) || attempt === ORDER_TRANSITION_MAX_RETRIES) {
                    if (this.isRetryableDbError(error))
                        this.logger.error(`${label} failed after ${attempt} attempts`, error instanceof Error ? error.stack : String(error));
                    throw error;
                }
                this.logger.warn(`${label} retrying attempt=${attempt}/${ORDER_TRANSITION_MAX_RETRIES}`);
                await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt - 1)));
            }
        }
        throw new Error(`${label}: retry loop exhausted`);
    }
    enqueueOrderNotificationBestEffort(payload, context) {
        void this.notificationQueue.enqueue(payload).catch((error) => {
            this.logger.warn(`${context} notification enqueue failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
    runRealtimeBestEffort(task, context) {
        try {
            task();
        }
        catch (error) {
            this.logger.warn(`${context} realtime side effect failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async createOrder(userId, dto) {
        if (!Number.isSafeInteger(dto.orderValue) || dto.orderValue < this.configuredMinOrderValue || dto.orderValue > this.configuredMaxOrderValue) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.VALIDATION_ERROR,
                message: `Order value must be between Rp ${this.configuredMinOrderValue.toLocaleString()} and Rp ${this.configuredMaxOrderValue.toLocaleString()}`,
            });
        }
        if (!Number.isSafeInteger(dto.deliveryDeadlineDays) || dto.deliveryDeadlineDays < app_constants_1.DELIVERY_DEADLINE_DAYS_MIN || dto.deliveryDeadlineDays > app_constants_1.DELIVERY_DEADLINE_DAYS_MAX) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.VALIDATION_ERROR,
                message: `Delivery deadline must be between ${app_constants_1.DELIVERY_DEADLINE_DAYS_MIN} and ${app_constants_1.DELIVERY_DEADLINE_DAYS_MAX} days`,
            });
        }
        const sanitizedTitle = (typeof dto.title === 'string' ? dto.title : '').replace(/[<>"'&]/g, '').trim();
        const sanitizedDescription = (typeof dto.description === 'string' ? dto.description : '').replace(/[<>"'&]/g, '').trim();
        if (sanitizedTitle.length < 3 || sanitizedTitle.length > 100) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Order title must be between 3 and 100 characters after sanitization' });
        }
        if (sanitizedDescription.length < 10 || sanitizedDescription.length > 500) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Order description must be between 10 and 500 characters after sanitization' });
        }
        const KYC_THRESHOLD_IDR = app_constants_1.KYC_THRESHOLD;
        const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, isActive: true, isBanned: true, kycStatus: true, isKahadePlus: true, totalOrdersCompleted: true, fullName: true, username: true } });
        if (!user)
            throw new common_1.NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
        if (!user.isActive || user.isBanned) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.COUNTERPART_SUSPENDED, message: 'Your account is suspended' });
        }
        const rateLimitKey = `order_create_rate:${userId}`;
        const client = this.redis.getClient();
        const redisRateLimitKey = `${this.redis.getPrefix()}${rateLimitKey}`;
        const rateLimitScript = `
      local current = redis.call("INCR", KEYS[1])
      if current == 1 then
        redis.call("EXPIRE", KEYS[1], ARGV[1])
      end
      return current
    `;
        const rateLimit = this.configService.get('app.orderCreateRateLimit') ?? 5;
        const rateWindowSec = this.configService.get('app.orderCreateRateWindowSec') ?? 60;
        const orderRateCount = await client.eval(rateLimitScript, 1, redisRateLimitKey, String(rateWindowSec));
        if (orderRateCount > rateLimit) {
            throw new common_1.BadRequestException({ code: ErrorCodes.RATE_LIMIT_EXCEEDED, message: 'Too many order creation attempts. Please wait before trying again.' });
        }
        if (dto.orderValue >= KYC_THRESHOLD_IDR && user.kycStatus !== client_1.KycStatus.APPROVED) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.KYC_REQUIRED, message: 'KYC verification required for orders of Rp 2.000.000 and above' });
        }
        const normalizedCounterpartUsername = typeof dto.counterpartUsername === 'string' ? dto.counterpartUsername.trim().toLowerCase() : '';
        if (normalizedCounterpartUsername.length < 3 || normalizedCounterpartUsername.length > 50) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Counterpart username must be between 3 and 50 characters' });
        }
        const counterpart = await this.prisma.user.findUnique({ where: { username: normalizedCounterpartUsername } });
        if (!counterpart)
            throw new common_1.NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'Counterpart not found' });
        if (!counterpart.isActive || counterpart.isBanned) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.COUNTERPART_SUSPENDED, message: 'Counterpart account is suspended' });
        }
        if (counterpart.id === userId)
            throw new common_1.BadRequestException({ code: ErrorCodes.CANNOT_ORDER_SELF, message: 'Cannot create order with yourself' });
        if (dto.orderValue >= KYC_THRESHOLD_IDR && counterpart.kycStatus !== client_1.KycStatus.APPROVED) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.KYC_REQUIRED, message: 'Counterpart must complete KYC verification for orders of Rp 2.000.000 and above' });
        }
        const cooldownKey = `order_counterpart_cooldown:${[userId, counterpart.id].sort().join(':')}`;
        const cooldownAcquired = await this.redis.setNx(cooldownKey, '1', ORDER_COUNTERPART_COOLDOWN_SECONDS);
        if (!cooldownAcquired) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.ORDER_COUNTERPART_COOLDOWN,
                message: 'Please wait before creating another order with the same counterpart',
            });
        }
        const feeConfig = await this.feeCalculator.getFeeConfig();
        let effectiveKahadePlus = user.isKahadePlus;
        if (effectiveKahadePlus) {
            const subCacheKey = `subscription_status:${userId}`;
            const cachedSub = await this.redis.get(subCacheKey);
            if (cachedSub !== null) {
                effectiveKahadePlus = cachedSub === '1';
            }
            else {
                const activeSub = await this.prisma.subscription.findFirst({
                    where: {
                        userId,
                        status: { in: [client_1.SubscriptionStatus.ACTIVE, client_1.SubscriptionStatus.CANCELLED] },
                        currentPeriodEnd: { gt: new Date() },
                    },
                    select: { feeSavingsUsed: true, feeSavingsLimit: true },
                });
                if (!activeSub || activeSub.feeSavingsUsed >= activeSub.feeSavingsLimit) {
                    effectiveKahadePlus = false;
                }
                await this.redis.set(subCacheKey, effectiveKahadePlus ? '1' : '0', 300);
            }
        }
        const buyerId = dto.role === 'BUYER' ? userId : counterpart.id;
        const sellerId = dto.role === 'SELLER' ? userId : counterpart.id;
        let order;
        let feeCalculation;
        try {
            for (let attempt = 0; attempt < ORDER_CREATE_MAX_RETRIES; attempt++) {
                const orderId = (0, id_generator_util_1.generateOrderId)(await this.getNextOrderSerial());
                try {
                    const txResult = await this.prisma.$transaction(async (tx) => {
                        const [txUser, txCounterpart] = await Promise.all([
                            tx.user.findUnique({ where: { id: userId }, select: { id: true, isActive: true, isBanned: true, kycStatus: true } }),
                            tx.user.findUnique({ where: { id: counterpart.id }, select: { id: true, isActive: true, isBanned: true, kycStatus: true } }),
                        ]);
                        if (!txUser || !txUser.isActive || txUser.isBanned) {
                            throw new common_1.ForbiddenException({ code: ErrorCodes.COUNTERPART_SUSPENDED, message: 'Your account is suspended' });
                        }
                        if (!txCounterpart || !txCounterpart.isActive || txCounterpart.isBanned) {
                            throw new common_1.ForbiddenException({ code: ErrorCodes.COUNTERPART_SUSPENDED, message: 'Counterpart account is suspended' });
                        }
                        if (dto.orderValue >= KYC_THRESHOLD_IDR && txUser.kycStatus !== client_1.KycStatus.APPROVED) {
                            throw new common_1.ForbiddenException({ code: ErrorCodes.KYC_REQUIRED, message: 'KYC verification required for orders of Rp 2.000.000 and above' });
                        }
                        if (dto.orderValue >= KYC_THRESHOLD_IDR && txCounterpart.kycStatus !== client_1.KycStatus.APPROVED) {
                            throw new common_1.ForbiddenException({ code: ErrorCodes.KYC_REQUIRED, message: 'Counterpart must complete KYC verification for orders of Rp 2.000.000 and above' });
                        }
                        const block = await tx.blockList.findFirst({
                            where: { OR: [{ blockerId: userId, blockedId: counterpart.id }, { blockerId: counterpart.id, blockedId: userId }] },
                        });
                        if (block)
                            throw new common_1.BadRequestException({ code: ErrorCodes.USER_BLOCKED, message: 'Cannot create order with blocked user' });
                        let voucherDiscountSen = BigInt(0);
                        let resolvedVoucher = null;
                        if (dto.voucherCode) {
                            const [voucher] = await tx.$queryRaw `
              SELECT * FROM "vouchers"
              WHERE "code" = ${dto.voucherCode.trim().toUpperCase()}
              LIMIT 1
              FOR UPDATE
            `;
                            if (!voucher) {
                                throw new common_1.NotFoundException({ code: ErrorCodes.VOUCHER_NOT_FOUND, message: 'Voucher not found' });
                            }
                            const now = new Date();
                            if (!voucher.isActive || now < voucher.validFrom || now > voucher.validUntil) {
                                throw new common_1.BadRequestException({ code: ErrorCodes.VOUCHER_EXPIRED, message: 'Voucher is expired or inactive' });
                            }
                            {
                                if (voucher.maxUsageTotal != null && voucher.currentUsage >= voucher.maxUsageTotal) {
                                    throw new common_1.BadRequestException({ code: ErrorCodes.VOUCHER_USAGE_LIMIT_REACHED, message: 'Voucher has reached its maximum usage limit' });
                                }
                                if (voucher.applicableTo && voucher.applicableTo !== 'ALL') {
                                    const isBuyer = dto.role === 'BUYER';
                                    if (voucher.applicableTo === 'BUYER_ONLY' && !isBuyer) {
                                        throw new common_1.BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: 'This voucher is only available for buyers' });
                                    }
                                    if (voucher.applicableTo === 'SELLER_ONLY' && isBuyer) {
                                        throw new common_1.BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: 'This voucher is only available for sellers' });
                                    }
                                    if (voucher.applicableTo === 'NEW_USER' && user.totalOrdersCompleted > 0) {
                                        throw new common_1.BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: 'This voucher is only available for new users' });
                                    }
                                }
                                if (voucher.minOrderValue !== null && (0, currency_util_1.toSen)(dto.orderValue) < voucher.minOrderValue) {
                                    throw new common_1.BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: 'Order value does not meet the minimum requirement for this voucher' });
                                }
                                if (voucher.maxUsagePerUser != null) {
                                    const userUsageRows = await tx.$queryRaw `
                  SELECT "id" FROM "voucher_usages"
                  WHERE "voucherId" = ${voucher.id} AND "userId" = ${userId}
                  FOR UPDATE
                `;
                                    if (userUsageRows.length >= voucher.maxUsagePerUser) {
                                        throw new common_1.BadRequestException({
                                            code: ErrorCodes.VOUCHER_USAGE_LIMIT_REACHED,
                                            message: 'You have reached the per-user usage limit for this voucher',
                                        });
                                    }
                                }
                                if (voucher.voucherType === 'FEE_DISCOUNT_PERCENT' && voucher.discountPercent != null) {
                                    const orderValueSen = (0, currency_util_1.toSen)(dto.orderValue);
                                    const baseFeeSen = this.feeCalculator.getStandardFeeSen(orderValueSen, feeConfig);
                                    const percentBps = BigInt(Math.round(Number(voucher.discountPercent) * 100));
                                    voucherDiscountSen = (baseFeeSen * percentBps) / BigInt(10_000);
                                    if (voucher.maxDiscountAmount !== null && voucherDiscountSen > voucher.maxDiscountAmount) {
                                        voucherDiscountSen = voucher.maxDiscountAmount;
                                    }
                                }
                                else {
                                    voucherDiscountSen = BigInt(Number(voucher.discountAmount ?? 0));
                                }
                                resolvedVoucher = voucher;
                            }
                        }
                        const txFeeCalc = this.feeCalculator.calculateFee({
                            orderValue: dto.orderValue,
                            feeResponsibility: dto.feeResponsibility,
                            isKahadePlus: effectiveKahadePlus,
                            voucherDiscountSen,
                        }, feeConfig);
                        const deadlineDays = getConfirmationDeadlineDays(dto.orderType);
                        const confirmationDeadlineAt = (0, date_util_1.toWIB)().add(deadlineDays, 'day').toDate();
                        const newOrder = await tx.order.create({
                            data: {
                                orderId, buyerId, sellerId,
                                title: sanitizedTitle, description: sanitizedDescription,
                                orderType: dto.orderType, orderValue: (0, currency_util_1.toSen)(dto.orderValue),
                                feeAmount: txFeeCalc.feeAmount,
                                feeResponsibility: dto.feeResponsibility,
                                buyerFeeAmount: txFeeCalc.buyerFeeAmount,
                                sellerFeeAmount: txFeeCalc.sellerFeeAmount,
                                buyerPayAmount: txFeeCalc.buyerPayAmount,
                                sellerReceiveAmount: txFeeCalc.sellerReceiveAmount,
                                isKahadePlus: effectiveKahadePlus,
                                feeRate: txFeeCalc.feeRate,
                                deliveryDeadlineDays: dto.deliveryDeadlineDays,
                                confirmationDeadlineAt,
                                voucherDiscount: txFeeCalc.voucherDiscount,
                                voucherId: resolvedVoucher?.id ?? null,
                                createdByBuyer: dto.role === 'BUYER',
                            },
                        });
                        if (resolvedVoucher) {
                            await tx.voucherUsage.create({
                                data: {
                                    voucherId: resolvedVoucher.id,
                                    userId,
                                    orderId: newOrder.id,
                                    discountApplied: txFeeCalc.voucherDiscount,
                                },
                            });
                            const updatedVoucher = await tx.voucher.updateMany({
                                where: {
                                    id: resolvedVoucher.id,
                                    OR: [
                                        { maxUsageTotal: null },
                                        { currentUsage: { lt: resolvedVoucher.maxUsageTotal } },
                                    ],
                                },
                                data: { currentUsage: { increment: 1 } },
                            });
                            if (updatedVoucher.count === 0) {
                                throw new common_1.BadRequestException({
                                    code: ErrorCodes.VOUCHER_USAGE_LIMIT_REACHED,
                                    message: 'Voucher has reached its maximum usage limit',
                                });
                            }
                        }
                        await tx.chatRoom.create({ data: { orderId: newOrder.id } });
                        await tx.orderStatusHistory.create({
                            data: {
                                orderId: newOrder.id,
                                fromStatus: null,
                                toStatus: client_1.OrderStatus.WAITING_CONFIRMATION,
                                changedBy: userId,
                                changedByType: dto.role === 'BUYER' ? client_1.ActorType.BUYER : client_1.ActorType.SELLER,
                                reason: 'Order created',
                            },
                        });
                        return { order: newOrder, feeCalc: txFeeCalc };
                    }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
                    order = txResult.order;
                    feeCalculation = txResult.feeCalc;
                    break;
                }
                catch (err) {
                    if (err instanceof client_1.Prisma.PrismaClientKnownRequestError &&
                        (err.code === 'P2002' || err.code === 'P2034') &&
                        attempt < ORDER_CREATE_MAX_RETRIES - 1) {
                        const backoffMs = Math.min(100 * Math.pow(2, attempt), 2000);
                        this.logger.warn(`Order create transient conflict (${err.code}) on attempt ${attempt + 1}, retrying in ${backoffMs}ms`);
                        await new Promise(resolve => setTimeout(resolve, backoffMs));
                        continue;
                    }
                    throw err;
                }
            }
            if (!order || !feeCalculation) {
                throw new common_1.BadRequestException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Failed to create order after retries' });
            }
        }
        catch (err) {
            await this.redis.del(cooldownKey).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
            throw err;
        }
        if (effectiveKahadePlus) {
            const subCacheKey = `subscription_status:${userId}`;
            await this.redis.del(subCacheKey);
        }
        const counterpartId = dto.role === 'BUYER' ? sellerId : buyerId;
        const creatorName = (user.fullName || user.username || 'User').replace(/[<>"'&]/g, '');
        const notifTitle = sanitizedTitle.slice(0, 100);
        try {
            const prefs = await this.prisma.notificationPreference.findUnique({ where: { userId: counterpartId } });
            const shouldNotify = !prefs || this.isOrderNotificationEnabled(prefs);
            if (shouldNotify) {
                const escapedBody = this.escapePushBody(`${creatorName} created a new order "${notifTitle}" worth Rp ${dto.orderValue.toLocaleString('id-ID')}. Please confirm.`);
                await this.notificationQueue.enqueue({
                    userId: counterpartId,
                    type: client_1.NotificationType.ORDER_NEW,
                    title: 'New Order',
                    body: escapedBody,
                    pushData: { type: 'ORDER_NEW', orderId: order.orderId },
                });
            }
        }
        catch (error) {
            this.logger.warn(`CREATE_ORDER notification failed after commit: ${error instanceof Error ? error.message : String(error)}`);
        }
        return {
            orderId: order.orderId,
            status: order.status,
            feeCalculation: {
                feeRate: feeCalculation.feeRate,
                feeAmount: (0, bigint_util_1.safeBigIntToNumber)(feeCalculation.feeAmount / 100n),
                buyerFeeAmount: (0, bigint_util_1.safeBigIntToNumber)(feeCalculation.buyerFeeAmount / 100n),
                sellerFeeAmount: (0, bigint_util_1.safeBigIntToNumber)(feeCalculation.sellerFeeAmount / 100n),
                buyerPayAmount: (0, bigint_util_1.safeBigIntToNumber)(feeCalculation.buyerPayAmount / 100n),
                sellerReceiveAmount: (0, bigint_util_1.safeBigIntToNumber)(feeCalculation.sellerReceiveAmount / 100n),
                voucherDiscount: (0, bigint_util_1.safeBigIntToNumber)(feeCalculation.voucherDiscount / 100n),
            },
            confirmationDeadlineAt: order.confirmationDeadlineAt,
        };
    }
    isOrderNotificationEnabled(prefs) {
        return prefs.orderInApp || prefs.orderPush;
    }
    escapePushBody(text) {
        return text.replace(/[\u0000-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '').replace(/[\\]/g, '\\\\').replace(/"/g, '\\"');
    }
    async getOrders(userId, page, limit, status, role, search) {
        const safePage = Math.max(1, Math.trunc(Number.isFinite(page) ? page : 1));
        const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number.isFinite(limit) ? limit : 20)));
        const skip = (safePage - 1) * safeLimit;
        const where = {};
        const orConditions = [];
        if (role !== undefined && role !== 'BUYER' && role !== 'SELLER' && role !== 'ALL') {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Role must be BUYER, SELLER, or ALL' });
        }
        if (role === 'BUYER') {
            orConditions.push({ buyerId: userId });
        }
        else if (role === 'SELLER') {
            orConditions.push({ sellerId: userId });
        }
        else {
            orConditions.push({ buyerId: userId });
            orConditions.push({ sellerId: userId });
        }
        if (orConditions.length > 0)
            where.OR = orConditions;
        if (status) {
            const statusStr = String(status).toUpperCase();
            if (statusStr === 'ACTIVE') {
                where.status = { in: OrdersService_1.ACTIVE_STATUSES };
            }
            else if (Object.values(client_1.OrderStatus).includes(statusStr)) {
                where.status = statusStr;
            }
            else {
                throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid order status filter' });
            }
        }
        if (search && search.trim().length > 0) {
            const searchTerm = escapeLikePattern(search.trim().slice(0, 100));
            where.AND = [
                ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
                {
                    OR: [
                        { orderId: { contains: searchTerm, mode: 'insensitive' } },
                        { title: { contains: searchTerm, mode: 'insensitive' } },
                        { description: { contains: searchTerm, mode: 'insensitive' } },
                    ],
                },
            ];
        }
        const [orders, total] = await Promise.all([
            this.prisma.order.findMany({
                where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip, take: safeLimit,
                include: {
                    buyer: { select: { userId: true, username: true, fullName: true, avatarUrl: true } },
                    seller: { select: { userId: true, username: true, fullName: true, avatarUrl: true } },
                },
            }),
            this.prisma.order.count({ where }),
        ]);
        return {
            orders: orders.map((order) => ({
                orderId: order.orderId, orderNumber: order.orderId,
                title: order.title, description: order.description, status: order.status,
                orderType: order.orderType,
                orderValue: (0, currency_util_1.toIdr)(order.orderValue),
                buyerPayAmount: (0, currency_util_1.toIdr)(order.buyerPayAmount),
                sellerReceiveAmount: (0, currency_util_1.toIdr)(order.sellerReceiveAmount),
                ...(order.status === client_1.OrderStatus.CANCELLED ? { cancelReason: order.cancelReason ?? null } : {}),
                buyer: order.buyer, seller: order.seller,
                role: order.buyerId === userId ? 'BUYER' : 'SELLER',
                createdAt: order.createdAt,
            })),
            total, page: safePage, limit: safeLimit,
        };
    }
    async getOrderDetail(userId, orderId) {
        const order = await this.prisma.order.findFirst({
            where: { orderId },
            include: {
                buyer: { select: { userId: true, username: true, fullName: true, avatarUrl: true, kycStatus: true, averageRating: true, totalOrdersCompleted: true } },
                seller: { select: { userId: true, username: true, fullName: true, avatarUrl: true, kycStatus: true, averageRating: true, totalOrdersCompleted: true } },
                voucher: { select: { code: true, name: true } },
                statusHistories: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, fromStatus: true, toStatus: true, changedByType: true, reason: true, createdAt: true } },
                dispute: { select: { id: true, status: true } },
                chatRoom: { select: { id: true } },
            },
        });
        if (!order)
            throw new common_1.NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
        if (order.buyerId !== userId && order.sellerId !== userId) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Not authorized to view this order' });
        }
        const existingRating = await this.prisma.rating.findUnique({
            where: { orderId_giverId: { orderId: order.id, giverId: userId } },
        });
        return {
            order: {
                orderId: order.orderId, title: order.title, description: order.description,
                orderType: order.orderType, status: order.status,
                ...(order.status === client_1.OrderStatus.CANCELLED ? {
                    cancelReason: order.cancelReason ?? null,
                    cancelNote: order.cancelNote ?? null,
                } : {}),
                orderValue: (0, currency_util_1.toIdr)(order.orderValue), feeAmount: (0, currency_util_1.toIdr)(order.feeAmount),
                feeResponsibility: order.feeResponsibility,
                buyerFeeAmount: (0, currency_util_1.toIdr)(order.buyerFeeAmount), sellerFeeAmount: (0, currency_util_1.toIdr)(order.sellerFeeAmount),
                buyerPayAmount: (0, currency_util_1.toIdr)(order.buyerPayAmount), sellerReceiveAmount: (0, currency_util_1.toIdr)(order.sellerReceiveAmount),
                voucherDiscount: (0, currency_util_1.toIdr)(order.voucherDiscount), isKahadePlus: order.isKahadePlus,
                feeRate: order.feeRate, deliveryDeadlineDays: order.deliveryDeadlineDays,
                deliveryDeadlineAt: order.deliveryDeadlineAt,
                paymentDeadlineAt: order.paymentDeadlineAt,
                confirmationDeadlineAt: order.confirmationDeadlineAt ?? null,
                processingDeadlineAt: order.processingDeadlineAt ?? null,
                trackingNumber: order.trackingNumber, courierName: order.courierName,
                trackingNotes: order.trackingNotes ?? null,
                createdByRole: order.createdByBuyer ? 'BUYER' : 'SELLER',
                createdAt: order.createdAt, confirmedAt: order.confirmedAt,
                paidAt: order.paidAt, completedAt: order.completedAt,
                cancelledAt: order.cancelledAt,
                shippedAt: order.shippedAt ?? null, processedAt: order.processedAt ?? null, disputedAt: order.disputedAt ?? null,
                updatedAt: order.updatedAt ?? order.createdAt,
                postCompletionDisputeDeadlineAt: order.completedAt
                    ? new Date(order.completedAt.getTime() + app_constants_1.POST_COMPLETION_DISPUTE_WINDOW_HOURS * 60 * 60 * 1000)
                    : null,
                buyer: order.buyer, seller: order.seller, voucher: order.voucher,
                chatRoomId: order.chatRoom?.id ?? null,
                hasRated: !!existingRating,
                hasDispute: order.dispute !== null,
                disputeId: order.dispute?.id ?? null,
                dispute: order.dispute ? { id: order.dispute.id, status: order.dispute.status } : null,
                statusHistories: order.statusHistories ?? [],
            },
        };
    }
    async getOrderSummary(userId) {
        const buyerStatuses = [client_1.OrderStatus.WAITING_PAYMENT, client_1.OrderStatus.PROCESSING, client_1.OrderStatus.IN_DELIVERY];
        const sellerStatuses = [client_1.OrderStatus.WAITING_CONFIRMATION, client_1.OrderStatus.PROCESSING, client_1.OrderStatus.IN_DELIVERY];
        const [buyerAgg, sellerAgg, inDispute, pendingExtensions] = await Promise.all([
            this.prisma.order.aggregate({
                where: { buyerId: userId, status: { in: buyerStatuses } },
                _count: true,
                _sum: { buyerPayAmount: true },
            }),
            this.prisma.order.aggregate({
                where: { sellerId: userId, status: { in: sellerStatuses } },
                _count: true,
                _sum: { sellerReceiveAmount: true },
            }),
            this.prisma.order.count({ where: { OR: [{ buyerId: userId }, { sellerId: userId }], status: client_1.OrderStatus.DISPUTED } }),
            this.prisma.orderExtensionRequest.count({
                where: {
                    order: { OR: [{ buyerId: userId }, { sellerId: userId }] },
                    status: client_1.DeadlineExtensionStatus.PENDING,
                },
            }),
        ]);
        const buyerTotalValue = (0, currency_util_1.toIdr)(buyerAgg._sum.buyerPayAmount ?? BigInt(0));
        const sellerTotalValue = (0, currency_util_1.toIdr)(sellerAgg._sum.sellerReceiveAmount ?? BigInt(0));
        return {
            asBuyer: { count: buyerAgg._count, totalValue: buyerTotalValue },
            asSeller: { count: sellerAgg._count, totalValue: sellerTotalValue },
            inDispute,
            pendingExtensions,
        };
    }
    async calculateFee(dto, userId) {
        if (!Number.isSafeInteger(dto.orderValue) || dto.orderValue < this.configuredMinOrderValue || dto.orderValue > this.configuredMaxOrderValue) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `Order value must be an integer between Rp ${this.configuredMinOrderValue.toLocaleString('id-ID')} and Rp ${this.configuredMaxOrderValue.toLocaleString('id-ID')}` });
        }
        if (!Object.values(client_1.FeeResponsibility).includes(dto.feeResponsibility)) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid fee responsibility' });
        }
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user)
            throw new common_1.NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
        let voucherDiscountSen = BigInt(0);
        const feeConfig = await this.feeCalculator.getFeeConfig();
        let effectiveKahadePlusEst = user.isKahadePlus;
        if (effectiveKahadePlusEst) {
            const activeSub = await this.prisma.subscription.findFirst({
                where: {
                    userId,
                    status: { in: [client_1.SubscriptionStatus.ACTIVE, client_1.SubscriptionStatus.CANCELLED] },
                    currentPeriodEnd: { gt: new Date() },
                },
                select: { feeSavingsUsed: true, feeSavingsLimit: true },
            });
            if (!activeSub || activeSub.feeSavingsUsed >= activeSub.feeSavingsLimit) {
                effectiveKahadePlusEst = false;
            }
        }
        if (dto.voucherCode) {
            const voucherCode = dto.voucherCode.trim().toUpperCase();
            if (voucherCode.length > 50) {
                throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Voucher code is too long' });
            }
            const voucher = await this.prisma.voucher.findFirst({
                where: {
                    code: voucherCode,
                    isActive: true,
                    validFrom: { lte: new Date() },
                    validUntil: { gte: new Date() },
                },
            });
            if (voucher) {
                if (voucher.maxUsageTotal != null && voucher.currentUsage >= voucher.maxUsageTotal) {
                    throw new common_1.BadRequestException({ code: ErrorCodes.VOUCHER_USAGE_LIMIT_REACHED, message: 'Voucher has reached its maximum usage limit' });
                }
                if (voucher.maxUsagePerUser != null) {
                    const userUsageCount = await this.prisma.voucherUsage.count({
                        where: { voucherId: voucher.id, userId },
                    });
                    if (userUsageCount >= voucher.maxUsagePerUser) {
                        throw new common_1.BadRequestException({
                            code: ErrorCodes.VOUCHER_USAGE_LIMIT_REACHED,
                            message: 'You have reached the per-user usage limit for this voucher',
                        });
                    }
                }
                if (voucher.minOrderValue !== null && (0, currency_util_1.toSen)(dto.orderValue) < voucher.minOrderValue) {
                    throw new common_1.BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: 'Order value does not meet the minimum requirement for this voucher' });
                }
                if (voucher.applicableTo && voucher.applicableTo !== 'ALL') {
                    if (voucher.applicableTo === 'NEW_USER' && user.totalOrdersCompleted > 0) {
                        throw new common_1.BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: 'This voucher is only available for new users' });
                    }
                    if (voucher.applicableTo === 'BUYER_ONLY' || voucher.applicableTo === 'SELLER_ONLY') {
                        if (!dto.role) {
                            throw new common_1.BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: `This voucher is only for ${voucher.applicableTo === 'BUYER_ONLY' ? 'buyers' : 'sellers'}. Please specify your role.` });
                        }
                        const isBuyer = dto.role === 'BUYER';
                        if (voucher.applicableTo === 'BUYER_ONLY' && !isBuyer) {
                            throw new common_1.BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: 'This voucher is only available for buyers' });
                        }
                        if (voucher.applicableTo === 'SELLER_ONLY' && isBuyer) {
                            throw new common_1.BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: 'This voucher is only available for sellers' });
                        }
                    }
                }
                if (voucher.voucherType === 'FEE_DISCOUNT_PERCENT' && voucher.discountPercent != null) {
                    const orderValueSen = (0, currency_util_1.toSen)(dto.orderValue);
                    const baseFeeSen = this.feeCalculator.getStandardFeeSen(orderValueSen, feeConfig);
                    const percentBps = BigInt(Math.round(Number(voucher.discountPercent) * 100));
                    voucherDiscountSen = (baseFeeSen * percentBps) / BigInt(10_000);
                    if (voucher.maxDiscountAmount !== null && voucherDiscountSen > voucher.maxDiscountAmount) {
                        voucherDiscountSen = voucher.maxDiscountAmount;
                    }
                }
                else {
                    voucherDiscountSen = BigInt(Number(voucher.discountAmount ?? 0));
                }
            }
        }
        const feeCalculation = this.feeCalculator.calculateFee({
            orderValue: dto.orderValue,
            feeResponsibility: dto.feeResponsibility,
            isKahadePlus: effectiveKahadePlusEst,
            voucherDiscountSen,
        }, feeConfig);
        return {
            feeRate: feeCalculation.feeRate,
            feeAmount: (0, bigint_util_1.safeBigIntToNumber)(feeCalculation.feeAmount / 100n),
            buyerFeeAmount: (0, bigint_util_1.safeBigIntToNumber)(feeCalculation.buyerFeeAmount / 100n),
            sellerFeeAmount: (0, bigint_util_1.safeBigIntToNumber)(feeCalculation.sellerFeeAmount / 100n),
            buyerPayAmount: (0, bigint_util_1.safeBigIntToNumber)(feeCalculation.buyerPayAmount / 100n),
            sellerReceiveAmount: (0, bigint_util_1.safeBigIntToNumber)(feeCalculation.sellerReceiveAmount / 100n),
            voucherDiscount: (0, bigint_util_1.safeBigIntToNumber)(feeCalculation.voucherDiscount / 100n),
            isKahadePlusApplied: effectiveKahadePlusEst,
        };
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
        const serial = await redisClient.eval(atomicScript, 1, redisKey, (86400 * 2).toString());
        if (serial === 1) {
            const syncLockKey = `order_serial_sync:${today}`;
            const lockAcquired = await this.redis.setNx(syncLockKey, '1', 60);
            if (lockAcquired) {
                try {
                    const maxOrder = await this.prisma.order.findFirst({
                        where: { orderId: { startsWith: `ORD-${today}-` } },
                        orderBy: { orderId: 'desc' },
                        select: { orderId: true },
                    });
                    if (maxOrder) {
                        const parts = maxOrder.orderId.split('-');
                        const existingSerial = parseInt(parts[2], 10);
                        if (existingSerial >= 1) {
                            const setIfHigherScript = `
                local current = tonumber(redis.call("get", KEYS[1]) or "0")
                local desired = tonumber(ARGV[1])
                if desired > current then
                  redis.call("set", KEYS[1], ARGV[1])
                  redis.call("expire", KEYS[1], ARGV[2])
                  return desired
                end
                return current
              `;
                            const newSerial = await redisClient.eval(setIfHigherScript, 1, redisKey, (existingSerial + 1).toString(), (86400 * 2).toString());
                            return newSerial;
                        }
                    }
                }
                finally {
                    await this.redis.del(syncLockKey);
                }
            }
            else {
                await new Promise(r => setTimeout(r, 50));
                return await redisClient.eval(atomicScript, 1, redisKey, (86400 * 2).toString());
            }
        }
        return serial;
    }
    async validateCounterpart(userId, counterpartUsername) {
        const normalizedUsername = typeof counterpartUsername === 'string' ? counterpartUsername.trim().toLowerCase() : '';
        if (normalizedUsername.length < 3 || normalizedUsername.length > 50) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Username must be between 3 and 50 characters' });
        }
        const counterpart = await this.prisma.user.findUnique({
            where: { username: normalizedUsername },
            select: {
                id: true, username: true, fullName: true, avatarUrl: true,
                isActive: true, isBanned: true, kycStatus: true,
                membershipRank: true, averageRating: true, totalOrdersCompleted: true,
            },
        });
        if (!counterpart) {
            return { user: null, isBlocked: false, canCreateOrder: false, reason: 'USER_NOT_FOUND' };
        }
        if (counterpart.id === userId) {
            throw new common_1.BadRequestException({ code: ErrorCodes.CANNOT_ORDER_SELF, message: 'Cannot validate yourself as a counterpart' });
        }
        const block = await this.prisma.blockList.findFirst({
            where: { OR: [{ blockerId: userId, blockedId: counterpart.id }, { blockerId: counterpart.id, blockedId: userId }] },
        });
        const canCreateOrder = counterpart.isActive && !counterpart.isBanned && !block;
        return {
            user: {
                username: counterpart.username,
                fullName: counterpart.fullName,
                avatarUrl: counterpart.avatarUrl,
                isKycVerified: counterpart.kycStatus === client_1.KycStatus.APPROVED,
                membershipRank: counterpart.membershipRank,
                avgRating: counterpart.averageRating,
            },
            isBlocked: !!block,
            canCreateOrder,
        };
    }
    async processOrder(orderId, sellerId) {
        let buyerId;
        let orderType;
        await this.withSerializableRetry(() => this.prisma.$transaction(async (tx) => {
            const order = await tx.order.findFirst({
                where: { orderId, sellerId },
            });
            if (!order) {
                const exists = await tx.order.findUnique({ where: { orderId }, select: { id: true } });
                if (!exists)
                    throw new common_1.NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
                throw new common_1.ForbiddenException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Not authorized' });
            }
            if (order.status !== client_1.OrderStatus.PROCESSING)
                throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order is not in PROCESSING status' });
            if (order.orderType === client_1.OrderType.PHYSICAL_GOODS && (!order.trackingNumber || !order.courierName)) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.VALIDATION_ERROR,
                    message: 'Tracking number and courier must be provided before marking a physical order as in delivery',
                });
            }
            buyerId = order.buyerId;
            orderType = order.orderType;
            const now = new Date();
            const deliveryDeadlineAt = order.deliveryDeadlineAt ?? (0, date_util_1.addDays)(now, order.deliveryDeadlineDays);
            const updated = await tx.order.updateMany({ where: { id: order.id, status: client_1.OrderStatus.PROCESSING }, data: { status: client_1.OrderStatus.IN_DELIVERY, shippedAt: order.shippedAt ?? now, processedAt: order.processedAt ?? now, deliveryDeadlineAt } });
            if (updated.count === 0) {
                throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order status has already changed' });
            }
            await tx.orderStatusHistory.create({ data: { orderId: order.id, fromStatus: client_1.OrderStatus.PROCESSING, toStatus: client_1.OrderStatus.IN_DELIVERY, changedBy: sellerId, changedByType: client_1.ActorType.SELLER } });
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable }), 'PROCESS_ORDER_TX');
        if (buyerId) {
            const isPhysicalOrder = orderType === client_1.OrderType.PHYSICAL_GOODS;
            const notificationType = isPhysicalOrder ? client_1.NotificationType.ORDER_SHIPPED : client_1.NotificationType.ORDER_DELIVERED;
            this.enqueueOrderNotificationBestEffort({
                userId: buyerId,
                type: notificationType,
                title: isPhysicalOrder ? 'Order Shipped' : 'Order Ready for Review',
                body: isPhysicalOrder
                    ? `Order ${orderId} has been shipped by the seller. Please check the tracking number.`
                    : `Order ${orderId} is ready for your delivery-proof review.`,
                pushData: { type: notificationType, orderId },
            }, `PROCESS_ORDER orderId=${orderId}`);
        }
        this.runRealtimeBestEffort(() => this.realtime.emitToOrder(orderId, 'order.status_changed', { orderId, status: 'IN_DELIVERY' }), `PROCESS_ORDER_STATUS orderId=${orderId}`);
        this.runRealtimeBestEffort(() => this.realtime.emitToOrder(orderId, 'order.status', { orderId, status: 'IN_DELIVERY' }), `PROCESS_ORDER_STATUS_LEGACY orderId=${orderId}`);
        return { orderId, status: 'IN_DELIVERY' };
    }
    async updateShipping(orderId, sellerId, dto) {
        const validStatuses = [client_1.OrderStatus.PROCESSING, client_1.OrderStatus.IN_DELIVERY];
        const result = await this.withSerializableRetry(() => this.prisma.$transaction(async (tx) => {
            const order = await tx.order.findUnique({ where: { orderId } });
            if (!order)
                throw new common_1.NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
            if (order.sellerId !== sellerId)
                throw new common_1.ForbiddenException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Not authorized' });
            if (!validStatuses.includes(order.status)) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.INVALID_ORDER_STATUS,
                    message: 'Order is not in a valid status for shipping update',
                });
            }
            await tx.$queryRaw `SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`;
            const freshOrder = await tx.order.findUnique({ where: { id: order.id } });
            if (!freshOrder || !validStatuses.includes(freshOrder.status) || freshOrder.sellerId !== sellerId) {
                throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order is no longer available for shipping update' });
            }
            const trackingNumber = dto.trackingNumber?.trim() || null;
            const courierName = dto.courierName?.trim() || null;
            if (freshOrder.orderType === client_1.OrderType.PHYSICAL_GOODS && (!trackingNumber || !courierName)) {
                throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Tracking number and courier are required for physical orders' });
            }
            if (freshOrder.orderType !== client_1.OrderType.PHYSICAL_GOODS && (trackingNumber !== null || courierName !== null)) {
                throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Tracking number and courier are only valid for physical orders' });
            }
            const updated = await tx.order.updateMany({
                where: { id: order.id, status: freshOrder.status },
                data: {
                    trackingNumber,
                    courierName,
                    ...(dto.trackingNotes !== undefined ? { trackingNotes: dto.trackingNotes.trim() || null } : {}),
                },
            });
            if (updated.count === 0) {
                throw new common_1.ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Order status has already changed' });
            }
            await tx.orderStatusHistory.create({
                data: {
                    orderId: order.id,
                    fromStatus: freshOrder.status,
                    toStatus: freshOrder.status,
                    changedBy: sellerId,
                    changedByType: client_1.ActorType.SELLER,
                    reason: 'SHIPPING_DETAILS_UPDATED',
                    metadata: { trackingNumber: Boolean(trackingNumber), courierName: Boolean(courierName) },
                },
            });
            return { trackingNumber, courierName };
        }), 'UPDATE_SHIPPING_TX');
        return { orderId, ...result };
    }
    async getOrderHistory(orderId, userId, page = 1, limit = 20) {
        const safePage = Math.max(1, Math.trunc(Number.isFinite(page) ? page : 1));
        const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number.isFinite(limit) ? limit : 20)));
        const skip = (safePage - 1) * safeLimit;
        const order = await this.prisma.order.findUnique({ where: { orderId } });
        if (!order)
            throw new common_1.NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
        if (order.buyerId !== userId && order.sellerId !== userId)
            throw new common_1.ForbiddenException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Not authorized' });
        const [history, total] = await Promise.all([
            this.prisma.orderStatusHistory.findMany({
                where: { orderId: order.id },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                skip,
                take: safeLimit,
            }),
            this.prisma.orderStatusHistory.count({ where: { orderId: order.id } }),
        ]);
        return {
            data: history.map(({ id: _id, ...rest }) => rest),
            total,
            page: safePage,
            limit: safeLimit,
            totalPages: Math.ceil(total / safeLimit),
        };
    }
    async getAverageDurations() {
        const cached = await this.redis.get(redis_keys_1.ORDER_AVG_DURATIONS_CACHE);
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
                    return parsed;
            }
            catch {
            }
        }
        const rows = await this.prisma.$queryRaw `
      WITH completed_orders AS (
        SELECT id, "createdAt" AS order_created_at FROM "orders" WHERE "status" = 'COMPLETED'::"OrderStatus"
      ),
      all_transitions AS (
        SELECT
          h."orderId",
          h."toStatus",
          h."createdAt",
          LEAD(h."createdAt") OVER (PARTITION BY h."orderId" ORDER BY h."createdAt" ASC) AS next_ts
        FROM "order_status_histories" h
        INNER JOIN completed_orders co ON co.id = h."orderId"
      ),
      creation_durations AS (
        SELECT
          co.id AS "orderId",
          'WAITING_CONFIRMATION' AS "toStatus",
          co.order_created_at AS "createdAt",
          MIN(h."createdAt") AS next_ts
        FROM completed_orders co
        INNER JOIN "order_status_histories" h ON h."orderId" = co.id
        GROUP BY co.id, co.order_created_at
      ),
      combined AS (
        SELECT "orderId", "toStatus", "createdAt", next_ts
        FROM all_transitions
        WHERE "toStatus" IN ('WAITING_CONFIRMATION', 'WAITING_PAYMENT', 'PROCESSING', 'IN_DELIVERY')
          AND next_ts IS NOT NULL
        UNION ALL
        SELECT "orderId", "toStatus", "createdAt", next_ts
        FROM creation_durations
        WHERE next_ts IS NOT NULL
      )
      SELECT
        c."toStatus" AS from_status,
        AVG(EXTRACT(EPOCH FROM (c.next_ts - c."createdAt")) / 3600) AS avg_hours
      FROM combined c
      GROUP BY c."toStatus"
    `;
        const result = {};
        for (const row of rows) {
            if (row.avg_hours != null && !isNaN(Number(row.avg_hours))) {
                result[row.from_status] = Math.round(Number(row.avg_hours) * 10) / 10;
            }
        }
        await this.redis.set(redis_keys_1.ORDER_AVG_DURATIONS_CACHE, JSON.stringify(result), 3600);
        return result;
    }
};
exports.OrdersService = OrdersService;
OrdersService.ACTIVE_STATUSES = [
    client_1.OrderStatus.WAITING_CONFIRMATION,
    client_1.OrderStatus.WAITING_PAYMENT,
    client_1.OrderStatus.PROCESSING,
    client_1.OrderStatus.IN_DELIVERY,
];
exports.OrdersService = OrdersService = OrdersService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService,
        realtime_service_1.RealtimeService,
        fee_calculator_service_1.FeeCalculatorService,
        config_1.ConfigService,
        notification_queue_service_1.NotificationQueueService])
], OrdersService);
