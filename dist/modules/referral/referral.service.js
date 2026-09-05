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
var ReferralService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReferralService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const prisma_service_1 = require("../../prisma/prisma.service");
const redis_service_1 = require("../../redis/redis.service");
const client_1 = require("@prisma/client");
const id_generator_util_1 = require("../../common/utils/id-generator.util");
const wallet_tx_serial_service_1 = require("../../common/services/wallet-tx-serial.service");
const pagination_dto_1 = require("../../common/dto/pagination.dto");
const currency_util_1 = require("../../common/utils/currency.util");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const REFERRAL_REWARD_AMOUNT = BigInt(500_000);
let ReferralService = ReferralService_1 = class ReferralService {
    constructor(prisma, redis, walletTxSerialService, configService) {
        this.prisma = prisma;
        this.redis = redis;
        this.walletTxSerialService = walletTxSerialService;
        this.configService = configService;
        this.logger = new common_1.Logger(ReferralService_1.name);
    }
    async getOrCreateCode(userId) {
        const existing = await this.prisma.referralCode.findUnique({ where: { userId } });
        if (existing)
            return existing;
        const MAX_RETRIES = 3;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            const code = (0, id_generator_util_1.generateReferralCode)();
            try {
                return await this.prisma.referralCode.upsert({
                    where: { userId },
                    update: {},
                    create: {
                        userId,
                        code,
                    },
                });
            }
            catch (err) {
                if (err instanceof client_1.Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
                    this.logger.warn(`Referral code collision on attempt ${attempt + 1}, retrying...`);
                    continue;
                }
                throw err;
            }
        }
        throw new common_1.BadRequestException({
            code: 'REFERRAL_CODE_GEN_FAILED',
            message: 'Failed to generate a unique referral code',
        });
    }
    async applyCode(userId, code) {
        const normalizedCode = code.trim().toUpperCase();
        const MAX_REFERRALS_PER_CODE = this.configService.get('app.maxReferralsPerCode') ?? 100;
        try {
            const relation = await this.prisma.$transaction(async (tx) => {
                const referralCode = await tx.referralCode.findUnique({
                    where: { code: normalizedCode },
                    include: { user: { select: { id: true, userId: true } } },
                });
                if (!referralCode || !referralCode.isActive) {
                    throw new common_1.NotFoundException({
                        code: ErrorCodes.REFERRAL_CODE_NOT_FOUND,
                        message: 'Referral code not found or inactive',
                    });
                }
                if (referralCode.userId === userId) {
                    throw new common_1.BadRequestException({
                        code: ErrorCodes.REFERRAL_SELF,
                        message: 'Cannot use your own referral code',
                    });
                }
                const existingRelation = await tx.referralRelation.findUnique({
                    where: { refereeId: userId },
                });
                if (existingRelation) {
                    throw new common_1.BadRequestException({
                        code: ErrorCodes.REFERRAL_ALREADY_APPLIED,
                        message: 'You have already applied a referral code',
                    });
                }
                let currentReferrerId = referralCode.userId;
                const visited = new Set([userId]);
                for (let depth = 0; depth < 10; depth++) {
                    if (visited.has(currentReferrerId)) {
                        throw new common_1.BadRequestException({
                            code: 'CIRCULAR_REFERRAL',
                            message: 'Circular referral is not allowed',
                        });
                    }
                    visited.add(currentReferrerId);
                    const upstream = await tx.referralRelation.findFirst({
                        where: { refereeId: currentReferrerId },
                        select: { referrerId: true },
                    });
                    if (!upstream)
                        break;
                    currentReferrerId = upstream.referrerId;
                }
                const codeUpdated = await tx.referralCode.updateMany({
                    where: {
                        id: referralCode.id,
                        isActive: true,
                        totalReferrals: { lt: MAX_REFERRALS_PER_CODE },
                    },
                    data: {
                        totalReferrals: { increment: 1 },
                    },
                });
                if (codeUpdated.count === 0) {
                    throw new common_1.BadRequestException({
                        code: 'REFERRAL_LIMIT_REACHED',
                        message: 'This referral code has reached its maximum usage limit or is no longer active',
                    });
                }
                const rel = await tx.referralRelation.create({
                    data: {
                        referralCodeId: referralCode.id,
                        referrerId: referralCode.userId,
                        refereeId: userId,
                    },
                });
                return rel;
            }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
            return relation;
        }
        catch (err) {
            if (err instanceof client_1.Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.REFERRAL_ALREADY_APPLIED,
                    message: 'You have already applied a referral code',
                });
            }
            throw err;
        }
    }
    async getStats(userId) {
        const referralCode = await this.prisma.referralCode.findUnique({
            where: { userId },
        });
        if (!referralCode) {
            return {
                code: null,
                totalReferrals: 0,
                successfulReferrals: 0,
                totalRewardEarned: 0,
                pendingRewardCount: 0,
            };
        }
        const [totalReferrals, successfulReferrals, pendingRewardCount] = await Promise.all([
            this.prisma.referralRelation.count({
                where: { referrerId: userId },
            }),
            this.prisma.referralRelation.count({
                where: { referrerId: userId, isRewardActive: true },
            }),
            this.prisma.referralReward.count({
                where: {
                    referrerId: userId,
                    isCredited: false,
                },
            }),
        ]);
        return {
            code: referralCode.code,
            totalReferrals,
            successfulReferrals,
            totalRewardEarned: (0, currency_util_1.toIdr)(referralCode.totalRewardEarned),
            pendingRewardCount,
        };
    }
    async getRewards(userId, page, limit) {
        const safePage = Math.max(1, Math.trunc(Number(page) || 1));
        const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number(limit) || 20)));
        const where = { referrerId: userId };
        const [data, total] = await Promise.all([
            this.prisma.referralReward.findMany({
                where,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                skip: (safePage - 1) * safeLimit,
                take: safeLimit,
            }),
            this.prisma.referralReward.count({ where }),
        ]);
        const serialized = data.map(r => ({
            id: r.id,
            feeAmount: (0, currency_util_1.toIdr)(r.feeAmount),
            rewardAmount: (0, currency_util_1.toIdr)(r.rewardAmount),
            isCredited: r.isCredited,
            creditedAt: r.creditedAt,
            createdAt: r.createdAt,
        }));
        return (0, pagination_dto_1.createPaginatedResponse)(serialized, total, safePage, safeLimit);
    }
    async regenerateCode(userId) {
        const existing = await this.prisma.referralCode.findUnique({ where: { userId } });
        if (existing) {
            this.logger.warn(`[REFERRAL] User ${userId} regenerating referral code. Old code "${existing.code}" is now invalidated. Previously shared links will stop working.`);
        }
        const MAX_RETRIES = 3;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            const newCode = (0, id_generator_util_1.generateReferralCode)();
            try {
                return await this.prisma.referralCode.upsert({
                    where: { userId },
                    update: { code: newCode, isActive: true },
                    create: {
                        userId,
                        code: newCode,
                        isActive: true,
                    },
                });
            }
            catch (err) {
                if (err instanceof client_1.Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
                    this.logger.warn(`Referral code collision on regeneration attempt ${attempt + 1}, retrying...`);
                    continue;
                }
                throw err;
            }
        }
        throw new common_1.BadRequestException({
            code: 'REFERRAL_CODE_GEN_FAILED',
            message: 'Failed to generate a unique referral code',
        });
    }
    async getHistory(userId, page, limit) {
        const safePage = Math.max(1, Math.trunc(Number(page) || 1));
        const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number(limit) || 20)));
        const where = {
            OR: [{ referrerId: userId }, { refereeId: userId }],
        };
        const [data, total] = await Promise.all([
            this.prisma.referralRelation.findMany({
                where,
                include: {
                    referrer: { select: { userId: true, username: true, fullName: true } },
                    referee: { select: { userId: true, username: true, fullName: true } },
                    rewards: {
                        select: {
                            id: true,
                            feeAmount: true,
                            rewardAmount: true,
                            isCredited: true,
                            creditedAt: true,
                            createdAt: true,
                        },
                        take: 20,
                        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                    },
                },
                orderBy: [{ appliedAt: 'desc' }, { id: 'desc' }],
                skip: (safePage - 1) * safeLimit,
                take: safeLimit,
            }),
            this.prisma.referralRelation.count({ where }),
        ]);
        const serialized = data.map(rel => ({
            ...rel,
            viewerRole: rel.referrerId === userId ? 'REFERRER' : 'REFEREE',
            rewards: rel.rewards?.map(r => ({
                ...r,
                feeAmount: (0, currency_util_1.toIdr)(r.feeAmount),
                rewardAmount: (0, currency_util_1.toIdr)(r.rewardAmount),
            })),
        }));
        return (0, pagination_dto_1.createPaginatedResponse)(serialized, total, safePage, safeLimit);
    }
    async createReferralRewardIfEligible(userId, feeAmount, orderId, tx) {
        const relation = await tx.referralRelation.findUnique({
            where: { refereeId: userId },
        });
        if (!relation)
            return;
        if (relation.isRewardActive)
            return;
        const order = await tx.order.findUnique({
            where: { id: orderId },
            select: { status: true },
        });
        if (!order || order.status !== client_1.OrderStatus.COMPLETED) {
            this.logger.warn(`Referral reward skipped for order ${orderId}: order status is ${order?.status ?? 'NOT_FOUND'}, expected COMPLETED`);
            return;
        }
        const [referrer, referee] = await Promise.all([
            tx.user.findUnique({ where: { id: relation.referrerId }, select: { kycStatus: true } }),
            tx.user.findUnique({ where: { id: relation.refereeId }, select: { kycStatus: true } }),
        ]);
        if (!referrer || referrer.kycStatus !== client_1.KycStatus.APPROVED) {
            this.logger.log(`Referral reward skipped for order ${orderId}: referrer ${relation.referrerId} not KYC verified`);
            return;
        }
        if (!referee || referee.kycStatus !== client_1.KycStatus.APPROVED) {
            this.logger.log(`Referral reward skipped for order ${orderId}: referee ${relation.refereeId} not KYC verified`);
            return;
        }
        const referrerCompletedOrders = await tx.order.count({
            where: {
                OR: [{ buyerId: relation.referrerId }, { sellerId: relation.referrerId }],
                status: client_1.OrderStatus.COMPLETED,
            },
        });
        if (referrerCompletedOrders < 1) {
            this.logger.log(`Referral reward skipped for order ${orderId}: referrer ${relation.referrerId} has no completed transactions`);
            return;
        }
        const refereeCompletedOrders = await tx.order.count({
            where: {
                OR: [{ buyerId: relation.refereeId }, { sellerId: relation.refereeId }],
                status: client_1.OrderStatus.COMPLETED,
            },
        });
        if (refereeCompletedOrders !== 1) {
            this.logger.log(`Referral reward skipped for order ${orderId}: referee ${relation.refereeId} has ${refereeCompletedOrders} completed transactions (expected exactly 1 — first transaction)`);
            return;
        }
        const walletCount = await tx.wallet.count({
            where: { userId: { in: [relation.referrerId, relation.refereeId] } },
        });
        if (walletCount !== 2) {
            this.logger.warn(`Referral reward skipped for order ${orderId}: both referral wallets are required before crediting either side`);
            return;
        }
        const referrerCredited = await this.creditReward(relation.referrerId, REFERRAL_REWARD_AMOUNT, feeAmount, orderId, relation.id, 'Referral reward — you invited a new user', tx);
        const refereeCredited = await this.creditReward(relation.refereeId, REFERRAL_REWARD_AMOUNT, feeAmount, orderId, relation.id, 'Referral reward — welcome bonus for your first transaction', tx);
        if (!referrerCredited || !refereeCredited) {
            this.logger.warn(`Referral reward partially failed for order ${orderId}: referrer=${referrerCredited}, referee=${refereeCredited} — relation NOT activated`);
            return;
        }
        await tx.referralRelation.update({
            where: { id: relation.id },
            data: {
                isRewardActive: true,
                rewardActivatedAt: new Date(),
                isReferrerKyc: true,
                isRefereeKyc: true,
            },
        });
        this.logger.log(`Referral rewards Rp5.000 each credited to referrer ${relation.referrerId} and referee ${relation.refereeId} for order ${orderId}`);
    }
    async creditReward(userId, amount, feeAmount, orderId, relationId, description, tx) {
        const existingReward = await tx.referralReward.findFirst({
            where: { triggeredByOrderId: orderId, referrerId: userId },
            select: { id: true, isCredited: true },
        });
        if (existingReward) {
            this.logger.warn(`Referral reward already exists for order ${orderId} user ${userId} — skipping duplicate`);
            return existingReward.isCredited;
        }
        const lockedWallets = await tx.$queryRaw `
      SELECT id, "totalBalance" FROM wallets WHERE "userId" = ${userId} FOR UPDATE
    `;
        const lockedWallet = lockedWallets[0];
        if (!lockedWallet) {
            this.logger.warn(`User ${userId} has no wallet — skipping reward credit`);
            return false;
        }
        const reward = await tx.referralReward.create({
            data: {
                relationId,
                referrerId: userId,
                triggeredByOrderId: orderId,
                feeAmount,
                rewardAmount: amount,
                isCredited: false,
                creditedAt: null,
            },
        });
        const walletTxSerial = await this.walletTxSerialService.getNext();
        const walletTxId = (0, id_generator_util_1.generateWalletTxId)(walletTxSerial);
        await tx.wallet.update({
            where: { id: lockedWallet.id },
            data: {
                availableBalance: { increment: amount },
                totalBalance: { increment: amount },
                version: { increment: 1 },
            },
        });
        await tx.walletTransaction.create({
            data: {
                txId: walletTxId,
                walletId: lockedWallet.id,
                type: client_1.WalletTransactionType.REFERRAL_REWARD,
                status: client_1.WalletTransactionStatus.SUCCESS,
                amount,
                balanceBefore: lockedWallet.totalBalance,
                balanceAfter: lockedWallet.totalBalance + amount,
                orderId,
                description,
            },
        });
        await tx.referralReward.update({
            where: { id: reward.id },
            data: { isCredited: true, creditedAt: new Date() },
        });
        await tx.referralCode.updateMany({
            where: { userId },
            data: { totalRewardEarned: { increment: amount } },
        });
        return true;
    }
};
exports.ReferralService = ReferralService;
exports.ReferralService = ReferralService = ReferralService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService,
        wallet_tx_serial_service_1.WalletTxSerialService,
        config_1.ConfigService])
], ReferralService);
