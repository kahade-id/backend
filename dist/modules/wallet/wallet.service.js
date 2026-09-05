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
var WalletService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.WalletService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const prisma_service_1 = require("../../prisma/prisma.service");
const redis_service_1 = require("../../redis/redis.service");
const realtime_service_1 = require("../realtime/realtime.service");
const client_1 = require("@prisma/client");
const notification_category_map_1 = require("../notifications/notification-category.map");
const crypto_1 = require("crypto");
const currency_util_1 = require("../../common/utils/currency.util");
const date_util_1 = require("../../common/utils/date.util");
const crypto_util_1 = require("../../common/utils/crypto.util");
const id_generator_util_1 = require("../../common/utils/id-generator.util");
const app_constants_1 = require("../../common/constants/app.constants");
const wallet_tx_serial_service_1 = require("../../common/services/wallet-tx-serial.service");
const audit_log_service_1 = require("../../common/services/audit-log.service");
const pagination_dto_1 = require("../../common/dto/pagination.dto");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const midtrans_service_1 = require("../payment/midtrans.service");
const otp_service_1 = require("../auth/otp.service");
const client_2 = require("@prisma/client");
const bull_1 = require("@nestjs/bull");
const email_processor_1 = require("../queue/processors/email.processor");
const redis_keys_1 = require("../../common/constants/redis-keys");
const WITHDRAW_LIFECYCLE_LOCK_TTL_SECONDS = 90;
let WalletService = WalletService_1 = class WalletService {
    constructor(prisma, redis, configService, walletTxSerialService, auditLog, midtransService, otpService, realtime, emailQueue) {
        this.prisma = prisma;
        this.redis = redis;
        this.configService = configService;
        this.walletTxSerialService = walletTxSerialService;
        this.auditLog = auditLog;
        this.midtransService = midtransService;
        this.otpService = otpService;
        this.realtime = realtime;
        this.emailQueue = emailQueue;
        this.logger = new common_1.Logger(WalletService_1.name);
        this.dummyPinHash = null;
        this.paymentMethodsCache = null;
        this.PAYMENT_METHODS_CACHE_TTL = 60_000;
        this.dailyTopupLimit =
            this.configService.get('app.walletDailyTopupLimit') ?? app_constants_1.WALLET_DAILY_TOPUP_LIMIT;
        this.dailyWithdrawLimit =
            this.configService.get('app.walletDailyWithdrawLimit') ?? app_constants_1.WALLET_DAILY_WITHDRAW_LIMIT;
        this.minWithdraw =
            this.configService.get('app.walletMinWithdraw') ?? app_constants_1.WALLET_MIN_WITHDRAW;
        if (this.minWithdraw < 10000) {
            throw new Error(`WALLET_MIN_WITHDRAW is ${this.minWithdraw} — must be at least Rp 10,000`);
        }
        this.maxWithdrawPerTx =
            this.configService.get('app.walletMaxWithdrawPerTx') ?? app_constants_1.WALLET_MAX_WITHDRAW_PER_TX;
        const rawExpiry = this.configService.get('app.topupExpiryHours') ?? 24;
        this.topupExpiryHours = Math.max(1, rawExpiry);
        const pepper = this.configService.get('app.walletPinPepper') ??
            this.configService.get('WALLET_PIN_PEPPER');
        if (!pepper) {
            throw new Error('WALLET_PIN_PEPPER env var is required — set it before starting the application');
        }
        this.walletPinPepper = pepper;
        this.paymentFees = {
            bca: this.configService.get('app.paymentFeeVaBca') ?? 4000,
            bni: this.configService.get('app.paymentFeeVaBni') ?? 4000,
            bri: this.configService.get('app.paymentFeeVaBri') ?? 4000,
            mandiri: this.configService.get('app.paymentFeeVaMandiri') ?? 4000,
            permata: this.configService.get('app.paymentFeeVaPermata') ?? 4000,
            cimb: this.configService.get('app.paymentFeeVaCimb') ?? 4000,
            qrisBps: WalletService_1.percentToBps(this.configService.get('app.paymentFeeQrisPercent') ?? 0.7),
            gopayBps: WalletService_1.percentToBps(this.configService.get('app.paymentFeeGopayPercent') ?? 2.0),
            shopeePayBps: WalletService_1.percentToBps(this.configService.get('app.paymentFeeShopeePayPercent') ?? 2.0),
            ccBps: WalletService_1.percentToBps(this.configService.get('app.paymentFeeCreditCardPercent') ?? 2.9),
            ccFlat: this.configService.get('app.paymentFeeCreditCardFlat') ?? 2000,
            cstoreFlat: this.configService.get('app.paymentFeeCstoreFlat') ?? 5000,
            akulakuBps: WalletService_1.percentToBps(this.configService.get('app.paymentFeeAkulakuPercent') ?? 3.0),
            kredivoBps: WalletService_1.percentToBps(this.configService.get('app.paymentFeeKredivoPercent') ?? 3.0),
        };
    }
    async onModuleInit() {
        this.dummyPinHash = await (0, crypto_util_1.bcryptHash)('dummy_pin_for_timing_normalization', (0, crypto_util_1.getBcryptRounds)());
    }
    async getWallet(userId) {
        const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
        if (!wallet)
            throw new common_1.NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Wallet not found' });
        const todayStartWib = (0, date_util_1.startOfDayWIB)();
        const isNewDay = !wallet.lastLimitResetAt || wallet.lastLimitResetAt < todayStartWib;
        const effectiveTopup = isNewDay ? BigInt(0) : wallet.todayTopupAmount;
        const effectiveWithdraw = isNewDay ? BigInt(0) : wallet.todayWithdrawAmount;
        const today = (0, date_util_1.formatWIBDate)();
        const dailyKey = (0, redis_keys_1.DAILY_TRANSFER_AMOUNT)(userId, today);
        const currentDailyStr = await this.redis.get(dailyKey).catch(() => null);
        let todayTransferSen = BigInt(0);
        if (currentDailyStr != null) {
            try {
                const parsed = BigInt(currentDailyStr);
                if (parsed >= 0n && parsed <= BigInt(Number.MAX_SAFE_INTEGER)) {
                    todayTransferSen = parsed;
                }
                else {
                    this.logger.error(`Invalid daily transfer counter range for user=${userId}; treating as zero until reconciliation`);
                }
            }
            catch {
                this.logger.error(`Invalid daily transfer counter encoding for user=${userId}; treating as zero until reconciliation`);
            }
        }
        return {
            availableBalance: (0, currency_util_1.toIdr)(wallet.availableBalance),
            escrowBalance: (0, currency_util_1.toIdr)(wallet.escrowBalance),
            totalBalance: (0, currency_util_1.toIdr)(wallet.totalBalance),
            todayTopupAmount: (0, currency_util_1.toIdr)(effectiveTopup),
            todayWithdrawAmount: (0, currency_util_1.toIdr)(effectiveWithdraw),
            todayTransferAmount: (0, currency_util_1.toIdr)(todayTransferSen),
            dailyTopupLimit: this.dailyTopupLimit,
            dailyWithdrawLimit: this.dailyWithdrawLimit,
            dailyTransferLimit: app_constants_1.WALLET_DAILY_TRANSFER_LIMIT,
            kycFreeLimit: app_constants_1.WALLET_KYC_FREE_LIMIT,
            hasPin: wallet.walletPinHash !== null && wallet.walletPinHash !== '',
            isLocked: wallet.isLocked,
            lockReason: wallet.isLocked ? 'Your wallet has been locked. Please contact support.' : null,
        };
    }
    async getTransactions(userId, page, limit, type, from, to) {
        const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
        if (!wallet)
            throw new common_1.NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Wallet not found' });
        const safePage = Number.isFinite(page) && Number.isInteger(page) && page > 0 ? page : 1;
        const safeLimit = Number.isFinite(limit) && Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
        const skip = (safePage - 1) * safeLimit;
        const where = { walletId: wallet.id };
        if (type) {
            if (Object.values(client_1.WalletTransactionType).includes(type)) {
                where.type = type;
            }
            else {
                throw new common_1.BadRequestException({
                    code: 'INVALID_TRANSACTION_TYPE',
                    message: `Invalid transaction type: "${type}". Valid values: ${Object.values(client_1.WalletTransactionType).join(', ')}`,
                });
            }
        }
        if (from || to) {
            const MAX_DATE_RANGE_MS = 90 * 24 * 60 * 60 * 1000;
            where.createdAt = {};
            let fromDate;
            let toDate;
            if (from) {
                fromDate = (0, date_util_1.parseDateBoundaryWIB)(from, 'start');
                if (!fromDate) {
                    throw new common_1.BadRequestException({
                        code: 'INVALID_DATE_FORMAT',
                        message: "Invalid 'from' date format",
                    });
                }
                where.createdAt.gte = fromDate;
            }
            if (to) {
                toDate = (0, date_util_1.parseDateBoundaryWIB)(to, 'end');
                if (!toDate) {
                    throw new common_1.BadRequestException({
                        code: 'INVALID_DATE_FORMAT',
                        message: "Invalid 'to' date format",
                    });
                }
                where.createdAt.lte = toDate;
            }
            if (fromDate && !toDate) {
                where.createdAt.lte = new Date(fromDate.getTime() + MAX_DATE_RANGE_MS);
            }
            if (!fromDate && toDate) {
                where.createdAt.gte = new Date(toDate.getTime() - MAX_DATE_RANGE_MS);
            }
            if (fromDate && toDate) {
                if (fromDate.getTime() > toDate.getTime()) {
                    throw new common_1.BadRequestException({
                        code: 'INVALID_DATE_RANGE',
                        message: "'from' date must be before 'to' date",
                    });
                }
                if (toDate.getTime() - fromDate.getTime() > MAX_DATE_RANGE_MS) {
                    throw new common_1.BadRequestException({
                        code: 'DATE_RANGE_TOO_LARGE',
                        message: 'Date range must not exceed 90 days',
                    });
                }
            }
        }
        const [transactions, total] = await Promise.all([
            this.prisma.walletTransaction.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip,
                take: safeLimit,
                include: { order: { select: { orderId: true, title: true } } },
            }),
            this.prisma.walletTransaction.count({ where }),
        ]);
        return (0, pagination_dto_1.createPaginatedResponse)(transactions.map(tx => ({
            id: tx.id,
            txId: tx.txId,
            type: tx.type,
            status: tx.status,
            amount: (0, currency_util_1.toIdr)(tx.amount),
            description: tx.description,
            balanceBefore: (0, currency_util_1.toIdr)(tx.balanceBefore),
            balanceAfter: (0, currency_util_1.toIdr)(tx.balanceAfter),
            createdAt: tx.createdAt,
            order: tx.order,
        })), total, safePage, safeLimit);
    }
    async getTransactionDetail(userId, txId) {
        const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
        if (!wallet)
            throw new common_1.NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Wallet not found' });
        const transaction = await this.prisma.walletTransaction.findFirst({
            where: { txId, walletId: wallet.id },
            select: {
                id: true,
                txId: true,
                type: true,
                status: true,
                amount: true,
                description: true,
                balanceBefore: true,
                balanceAfter: true,
                createdAt: true,
                metadata: true,
                order: { select: { orderId: true, title: true, status: true } },
            },
        });
        if (!transaction)
            throw new common_1.NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Transaction not found' });
        return {
            id: transaction.id,
            txId: transaction.txId,
            type: transaction.type,
            status: transaction.status,
            amount: (0, currency_util_1.toIdr)(transaction.amount),
            description: transaction.description,
            balanceBefore: (0, currency_util_1.toIdr)(transaction.balanceBefore),
            balanceAfter: (0, currency_util_1.toIdr)(transaction.balanceAfter),
            createdAt: transaction.createdAt,
            metadata: transaction.metadata,
            order: transaction.order,
        };
    }
    static percentToBps(pct) {
        return Math.round(pct * 100);
    }
    static feeFromBps(amountIdr, bps) {
        const num = amountIdr * bps;
        const base = Math.trunc(num / 10000);
        return num % 10000 !== 0 ? base + 1 : base;
    }
    calculatePaymentFee(amount, method) {
        const f = this.paymentFees;
        switch (method) {
            case client_1.PaymentMethod.VIRTUAL_ACCOUNT_BCA:
                return f.bca;
            case client_1.PaymentMethod.VIRTUAL_ACCOUNT_BNI:
                return f.bni;
            case client_1.PaymentMethod.VIRTUAL_ACCOUNT_BRI:
                return f.bri;
            case client_1.PaymentMethod.VIRTUAL_ACCOUNT_MANDIRI:
                return f.mandiri;
            case client_1.PaymentMethod.VIRTUAL_ACCOUNT_PERMATA:
                return f.permata;
            case client_1.PaymentMethod.VIRTUAL_ACCOUNT_CIMB:
                return f.cimb;
            case client_1.PaymentMethod.QRIS:
                return WalletService_1.feeFromBps(amount, f.qrisBps);
            case client_1.PaymentMethod.GOPAY:
                return WalletService_1.feeFromBps(amount, f.gopayBps);
            case client_1.PaymentMethod.SHOPEEPAY:
                return WalletService_1.feeFromBps(amount, f.shopeePayBps);
            case client_1.PaymentMethod.CREDIT_CARD:
                return WalletService_1.feeFromBps(amount, f.ccBps) + f.ccFlat;
            case client_1.PaymentMethod.ALFAMART:
            case client_1.PaymentMethod.INDOMARET:
                return f.cstoreFlat;
            case client_1.PaymentMethod.AKULAKU:
                return WalletService_1.feeFromBps(amount, f.akulakuBps);
            case client_1.PaymentMethod.KREDIVO:
                return WalletService_1.feeFromBps(amount, f.kredivoBps);
            default:
                throw new common_1.BadRequestException({
                    code: ErrorCodes.INVALID_PAYMENT_METHOD,
                    message: 'Unsupported payment method',
                });
        }
    }
    async getTopupStatus(userId, paymentTxId) {
        const tx = await this.prisma.paymentTransaction.findFirst({
            where: { midtransOrderId: paymentTxId, userId },
            select: { midtransOrderId: true, status: true, amount: true },
        });
        if (!tx) {
            throw new common_1.NotFoundException({
                code: ErrorCodes.NOT_FOUND,
                message: 'Top-up transaction not found',
            });
        }
        return {
            status: tx.status,
            txId: tx.midtransOrderId,
            amount: (0, currency_util_1.toIdr)(tx.amount),
        };
    }
    async topup(userId, amount, method, cardToken) {
        if (!Number.isFinite(amount) ||
            !Number.isInteger(amount) ||
            amount <= 0 ||
            amount > Number.MAX_SAFE_INTEGER / 100) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.VALIDATION_ERROR,
                message: 'Top-up amount must be a finite positive whole IDR amount within the supported range',
            });
        }
        const paymentMethod = this.getPaymentMethods().methods.find(entry => entry.id === method);
        if (!paymentMethod) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.INVALID_PAYMENT_METHOD,
                message: 'Unsupported payment method',
            });
        }
        if (amount < paymentMethod.minAmount || amount > paymentMethod.maxAmount) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.VALIDATION_ERROR,
                message: `Top-up amount for ${method} must be between Rp ${paymentMethod.minAmount.toLocaleString('id-ID')} and Rp ${paymentMethod.maxAmount.toLocaleString('id-ID')}`,
            });
        }
        if (method === client_1.PaymentMethod.KAHADE_WALLET) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.INVALID_PAYMENT_METHOD,
                message: 'Cannot top up using Kahade Wallet balance. Please choose a payment method.',
            });
        }
        const UNSUPPORTED_CORE_API_METHODS = [
            client_1.PaymentMethod.OVO,
            client_1.PaymentMethod.DANA,
            client_1.PaymentMethod.LINKAJA,
            client_1.PaymentMethod.VIRTUAL_ACCOUNT_OTHER,
        ];
        if (UNSUPPORTED_CORE_API_METHODS.includes(method)) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.INVALID_PAYMENT_METHOD,
                message: `Payment method ${method} is not currently supported for direct top-up.`,
            });
        }
        if (method === client_1.PaymentMethod.CREDIT_CARD && !cardToken) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.INVALID_PAYMENT_METHOD,
                message: 'Card token is required for credit card payments. Please complete card tokenization first.',
            });
        }
        if (amount > app_constants_1.WALLET_KYC_FREE_LIMIT) {
            const user = await this.prisma.user.findUnique({
                where: { id: userId },
                select: { kycStatus: true },
            });
            if (!user || user.kycStatus !== client_1.KycStatus.APPROVED) {
                throw new common_1.ForbiddenException({
                    code: ErrorCodes.KYC_REQUIRED,
                    message: `Top-up above Rp ${app_constants_1.WALLET_KYC_FREE_LIMIT.toLocaleString('id-ID')} requires KYC verification. Please verify your identity first.`,
                });
            }
        }
        const walletForLock = await this.prisma.wallet.findUnique({
            where: { userId },
            select: { id: true },
        });
        if (!walletForLock)
            throw new common_1.NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Wallet not found' });
        const lockKey = (0, redis_keys_1.WALLET_LOCK)(userId);
        const lockToken = `topup:${Date.now()}:${(0, crypto_1.randomBytes)(16).toString('hex')}`;
        const acquired = await this.redis.setNx(lockKey, lockToken, 30);
        if (!acquired) {
            throw new common_1.ConflictException({
                code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                message: 'Another wallet operation is in progress. Please try again.',
            });
        }
        try {
            const paymentSerial = await this.getNextPaymentSerial();
            const walletTxSerial = await this.getNextWalletTxSerial();
            const amountInSen = (0, currency_util_1.toSen)(amount);
            const dailyLimit = (0, currency_util_1.toSen)(this.dailyTopupLimit);
            const result = await this.prisma.$transaction(async (tx) => {
                await tx.$queryRaw `SELECT id FROM wallets WHERE "userId" = ${userId} FOR UPDATE`;
                const wallet = await tx.wallet.findUnique({ where: { userId } });
                if (!wallet)
                    throw new common_1.NotFoundException({
                        code: ErrorCodes.NOT_FOUND,
                        message: 'Wallet not found',
                    });
                if (wallet.isLocked) {
                    this.logger.warn(`TOPUP_REJECTED wallet=${wallet.id} user=${userId} reason=wallet_locked amount=${amountInSen}`);
                    throw new common_1.ForbiddenException({
                        code: ErrorCodes.WALLET_LOCKED,
                        message: 'Wallet is locked',
                    });
                }
                const todayStartWib = (0, date_util_1.startOfDayWIB)();
                const effectiveTopup = wallet.lastLimitResetAt && wallet.lastLimitResetAt < todayStartWib
                    ? BigInt(0)
                    : wallet.todayTopupAmount;
                const newTopupAmount = effectiveTopup + amountInSen;
                if (newTopupAmount > dailyLimit) {
                    this.logger.warn(`TOPUP_REJECTED wallet=${wallet.id} user=${userId} reason=daily_limit_exceeded amount=${amountInSen} todayTotal=${effectiveTopup} limit=${dailyLimit}`);
                    throw new common_1.BadRequestException({
                        code: ErrorCodes.DAILY_TOPUP_LIMIT_EXCEEDED,
                        message: 'Daily topup limit exceeded',
                    });
                }
                const walletVersion = wallet.version;
                const paymentFee = this.calculatePaymentFee(amount, method);
                const grossAmount = amount + paymentFee;
                const paymentTxId = (0, id_generator_util_1.generatePaymentTxId)(paymentSerial);
                const paymentFeeSen = (0, currency_util_1.toSen)(paymentFee);
                const grossAmountSen = (0, currency_util_1.toSen)(grossAmount);
                const paymentTx = await tx.paymentTransaction.create({
                    data: {
                        midtransOrderId: paymentTxId,
                        userId,
                        method,
                        amount: amountInSen,
                        paymentFee: paymentFeeSen,
                        grossAmount: grossAmountSen,
                        status: client_1.PaymentStatus.PENDING,
                    },
                });
                const walletTxId = (0, id_generator_util_1.generateWalletTxId)(walletTxSerial);
                await tx.walletTransaction.create({
                    data: {
                        txId: walletTxId,
                        walletId: wallet.id,
                        type: client_1.WalletTransactionType.TOP_UP,
                        status: client_1.WalletTransactionStatus.PENDING,
                        amount: amountInSen,
                        balanceBefore: wallet.totalBalance,
                        balanceAfter: wallet.totalBalance,
                        paymentTxId: paymentTx.id,
                        description: `Top up via ${method}`,
                    },
                });
                const isNewDay = wallet.lastLimitResetAt && wallet.lastLimitResetAt < todayStartWib;
                const topupUpdateData = isNewDay
                    ? {
                        todayTopupAmount: amountInSen,
                        todayWithdrawAmount: BigInt(0),
                        lastLimitResetAt: new Date(),
                        version: { increment: 1 },
                    }
                    : { todayTopupAmount: { increment: amountInSen }, version: { increment: 1 } };
                const updated = await tx.wallet.updateMany({
                    where: { id: wallet.id, version: walletVersion },
                    data: topupUpdateData,
                });
                if (updated.count === 0) {
                    throw new common_1.ConflictException({
                        code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                        message: 'Concurrent wallet update detected, please retry',
                    });
                }
                return { paymentTxId, paymentDbId: paymentTx.id, paymentFee, grossAmount };
            }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
            const topupExpiryMs = this.topupExpiryHours * 60 * 60 * 1000;
            const user = await this.prisma.user.findUnique({
                where: { id: userId },
                select: { email: true, fullName: true },
            });
            let chargeResult;
            try {
                chargeResult = await this.midtransService.chargeTransaction({
                    orderId: result.paymentTxId,
                    grossAmount: result.grossAmount,
                    paymentMethod: method,
                    userEmail: user?.email ?? '',
                    fullName: user?.fullName ?? 'Kahade User',
                    cardToken,
                });
            }
            catch (chargeError) {
                this.logger.error(`Midtrans Core API charge failed for orderId=${result.paymentTxId}:`, chargeError);
                let providerStatus = null;
                try {
                    const providerTransaction = await this.midtransService.getTransactionStatus(result.paymentTxId);
                    const status = providerTransaction['transaction_status'];
                    providerStatus = typeof status === 'string' ? status.toLowerCase() : null;
                }
                catch (statusError) {
                    this.logger.warn(`Unable to reconcile failed charge immediately for orderId=${result.paymentTxId}: ` +
                        `${statusError instanceof Error ? statusError.message : String(statusError)}`);
                }
                const terminalProviderFailures = new Set(['deny', 'expire', 'cancel', 'failure']);
                if (!providerStatus || !terminalProviderFailures.has(providerStatus)) {
                    this.logger.warn(`Top-up charge outcome remains uncertain for orderId=${result.paymentTxId}; ` +
                        `keeping payment PENDING for webhook/expiry reconciliation (providerStatus=${providerStatus ?? 'unavailable'})`);
                    throw new common_1.ServiceUnavailableException({
                        code: 'PAYMENT_INITIATION_UNCERTAIN',
                        message: 'Payment initiation could not be confirmed. Check the payment status again shortly before trying a new top-up.',
                        paymentTxId: result.paymentTxId,
                    });
                }
                const MAX_ROLLBACK_RETRIES = 3;
                for (let attempt = 1; attempt <= MAX_ROLLBACK_RETRIES; attempt++) {
                    try {
                        await this.prisma.$transaction(async (tx) => {
                            await tx.paymentTransaction.update({
                                where: { midtransOrderId: result.paymentTxId },
                                data: { status: client_1.PaymentStatus.FAILED, failedAt: new Date() },
                            });
                            await tx.walletTransaction.updateMany({
                                where: {
                                    paymentTxId: result.paymentDbId,
                                    status: client_1.WalletTransactionStatus.PENDING,
                                },
                                data: { status: client_1.WalletTransactionStatus.FAILED },
                            });
                            const walletRows = await tx.$queryRaw `
                SELECT id, version, "todayTopupAmount" FROM wallets WHERE "userId" = ${userId} FOR UPDATE`;
                            const currentWallet = walletRows[0];
                            if (currentWallet) {
                                const rollbackResult = await tx.wallet.updateMany({
                                    where: { id: currentWallet.id, version: currentWallet.version },
                                    data: {
                                        todayTopupAmount: {
                                            decrement: currentWallet.todayTopupAmount >= amountInSen
                                                ? amountInSen
                                                : currentWallet.todayTopupAmount,
                                        },
                                        version: { increment: 1 },
                                    },
                                });
                                if (rollbackResult.count === 0) {
                                    throw new Error('OCC conflict during topup rollback');
                                }
                            }
                        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
                        break;
                    }
                    catch (rollbackErr) {
                        if (attempt === MAX_ROLLBACK_RETRIES) {
                            this.logger.error(`CRITICAL: Topup rollback failed after ${MAX_ROLLBACK_RETRIES} attempts for user ${userId}. ` +
                                `Daily counter may be overstated. Enqueuing background correction. Error: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`);
                            const correctionData = JSON.stringify({
                                userId,
                                amountInSen: amountInSen.toString(),
                                paymentTxId: result.paymentTxId,
                                timestamp: Date.now(),
                            });
                            const client = this.redis.getClient();
                            const listKey = this.redis.getPrefix() + 'topup_counter_corrections';
                            client
                                .rpush(listKey, correctionData)
                                .then(() => {
                                return client.expire(listKey, 7 * 24 * 60 * 60);
                            })
                                .catch((redisErr) => {
                                this.logger.error(`Failed to enqueue topup counter correction for user ${userId}: ${redisErr.message}`);
                            });
                        }
                        else {
                            this.logger.warn(`Topup rollback attempt ${attempt} failed for user ${userId}, retrying...`);
                            await new Promise(r => setTimeout(r, 100 * attempt));
                        }
                    }
                }
                throw new Error(`Payment gateway error: ${chargeError instanceof Error ? chargeError.message : 'Midtrans unavailable'}`);
            }
            const immediateChargeStatus = chargeResult.transactionStatus.toLowerCase();
            const terminalChargeStatuses = new Set([
                'deny',
                'expire',
                'cancel',
                'failure',
                'refund',
                'partial_refund',
                'chargeback',
                'partial_chargeback',
            ]);
            if (terminalChargeStatuses.has(immediateChargeStatus)) {
                await this.handleTopupFailure(result.paymentTxId, immediateChargeStatus.toUpperCase());
                throw new common_1.BadRequestException({
                    code: 'PAYMENT_INITIATION_DECLINED',
                    message: 'Payment provider declined or cancelled this top-up. No payment instruction was created.',
                });
            }
            if (!chargeResult.transactionId) {
                throw new common_1.ServiceUnavailableException({
                    code: 'PAYMENT_PROVIDER_INCOMPLETE',
                    message: 'Payment provider returned an incomplete transaction response; payment status is still being reconciled.',
                });
            }
            if (chargeResult.grossAmount &&
                this.parseProviderAmountToSen(chargeResult.grossAmount, 'gross_amount') !==
                    (0, currency_util_1.toSen)(result.grossAmount)) {
                throw new common_1.ServiceUnavailableException({
                    code: 'PAYMENT_PROVIDER_AMOUNT_MISMATCH',
                    message: 'Payment provider returned a different gross amount; payment status is still being reconciled.',
                });
            }
            this.auditLog.logUserAction({
                userId,
                action: client_2.UserAuditAction.TOPUP_INITIATED,
                entityType: 'WalletTransaction',
                entityId: result.paymentTxId,
                description: `User initiated topup of ${amount} via ${method}`,
            });
            return {
                paymentTxId: result.paymentTxId,
                transactionId: chargeResult.transactionId,
                method,
                amount,
                paymentFee: result.paymentFee,
                grossAmount: result.grossAmount,
                paymentType: chargeResult.paymentType,
                transactionStatus: chargeResult.transactionStatus,
                vaNumber: chargeResult.vaNumber,
                bankName: chargeResult.bankName,
                billKey: chargeResult.billKey,
                billerCode: chargeResult.billerCode,
                qrString: chargeResult.qrString,
                qrCodeUrl: chargeResult.qrCodeUrl,
                paymentCode: chargeResult.paymentCode,
                store: chargeResult.store,
                actions: chargeResult.actions,
                redirectUrl: chargeResult.redirectUrl,
                expiryTime: chargeResult.expiryTime,
                expiredAt: chargeResult.expiryTime
                    ? new Date(chargeResult.expiryTime)
                    : new Date(Date.now() + topupExpiryMs),
            };
        }
        finally {
            await this.redis
                .releaseLock(lockKey, lockToken)
                .catch((error) => this.logger.warn(`TOPUP lock release failed: ${error instanceof Error ? error.message : String(error)}`));
        }
    }
    async checkPinIpRateLimit(ip) {
        if (!ip)
            return;
        const ipAttemptKey = (0, redis_keys_1.WALLET_PIN_IP_ATTEMPTS)(ip);
        const rawIpAttempts = await this.redis.get(ipAttemptKey, { throwOnError: true });
        const ipAttempts = rawIpAttempts == null ? 0 : Number(rawIpAttempts);
        if (!Number.isSafeInteger(ipAttempts) || ipAttempts < 0) {
            throw new common_1.ServiceUnavailableException({
                code: 'PIN_RATE_LIMIT_UNAVAILABLE',
                message: 'PIN security controls are temporarily unavailable. Please try again later.',
            });
        }
        if (ipAttempts >= 20) {
            throw new common_1.ForbiddenException({
                code: ErrorCodes.PIN_IP_RATE_LIMITED,
                message: 'Too many failed PIN attempts from this address. Please try again later.',
            });
        }
    }
    async incrementPinIpAttempts(ip) {
        if (!ip)
            return;
        const ipAttemptKey = (0, redis_keys_1.WALLET_PIN_IP_ATTEMPTS)(ip);
        const newCount = await this.redis.incr(ipAttemptKey, { throwOnError: true });
        if (newCount === 1)
            await this.redis.expire(ipAttemptKey, 3600, { throwOnError: true });
    }
    getDummyPinHash() {
        if (!this.dummyPinHash) {
            throw new Error('Dummy PIN hash not initialized — onModuleInit must complete before verifying PINs');
        }
        return this.dummyPinHash;
    }
    async verifyWalletPin(wallet, pin, userId, ip) {
        await this.checkPinIpRateLimit(ip);
        const pinAttemptKey = (0, redis_keys_1.WALLET_PIN_ATTEMPTS)(userId);
        const rawAttempts = await this.redis.get(pinAttemptKey, { throwOnError: true });
        const currentAttempts = rawAttempts == null ? 0 : Number(rawAttempts);
        if (!Number.isSafeInteger(currentAttempts) || currentAttempts < 0) {
            throw new common_1.ServiceUnavailableException({
                code: 'PIN_RATE_LIMIT_UNAVAILABLE',
                message: 'PIN security controls are temporarily unavailable. Please try again later.',
            });
        }
        if (currentAttempts >= 5) {
            throw new common_1.ForbiddenException({
                code: ErrorCodes.PIN_RATE_LIMITED,
                message: 'Too many failed PIN attempts. Please try again in 15 minutes.',
            });
        }
        const hasPin = wallet.walletPinHash !== null && wallet.walletPinHash !== '';
        const hashToCompare = hasPin ? wallet.walletPinHash : this.getDummyPinHash();
        const pinDigest = (0, crypto_util_1.hmacPinDigest)(this.walletPinPepper, pin);
        let pinValid = await (0, crypto_util_1.bcryptCompare)(pinDigest, hashToCompare);
        if (!pinValid && hasPin) {
            const legacyValid = await (0, crypto_util_1.bcryptCompare)(this.walletPinPepper + pin, hashToCompare);
            if (legacyValid) {
                pinValid = true;
                const newDigest = (0, crypto_util_1.hmacPinDigest)(this.walletPinPepper, pin);
                const rehashed = await (0, crypto_util_1.bcryptHash)(newDigest, (0, crypto_util_1.getBcryptRounds)());
                await this.prisma.wallet.update({
                    where: { userId },
                    data: { walletPinHash: rehashed },
                });
            }
        }
        if (!hasPin) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.NOT_FOUND,
                message: 'Wallet PIN has not been set. Please set a PIN before proceeding.',
            });
        }
        if (!pinValid) {
            const newCount = await this.redis.incr(pinAttemptKey, { throwOnError: true });
            if (newCount === 1)
                await this.redis.expire(pinAttemptKey, 900, { throwOnError: true });
            await this.incrementPinIpAttempts(ip);
            throw new common_1.UnauthorizedException({
                code: ErrorCodes.UNAUTHORIZED,
                message: 'Invalid wallet PIN',
            });
        }
        await this.redis.del(pinAttemptKey, { throwOnError: true });
    }
    async withdraw(userId, amount, bankAccountId, pin, ip) {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user)
            throw new common_1.NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'User not found' });
        if (!user.email) {
            throw new common_1.BadRequestException({
                code: 'EMAIL_NOT_CONFIGURED',
                message: 'Add an email address before requesting a withdrawal confirmation code.',
            });
        }
        if (!Number.isFinite(amount) ||
            !Number.isInteger(amount) ||
            amount <= 0 ||
            amount > Number.MAX_SAFE_INTEGER / 100) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.VALIDATION_ERROR,
                message: 'Withdrawal amount must be a finite positive whole IDR amount within the supported range',
            });
        }
        if (amount > app_constants_1.WALLET_KYC_FREE_LIMIT && user.kycStatus !== client_1.KycStatus.APPROVED) {
            throw new common_1.ForbiddenException({
                code: ErrorCodes.KYC_REQUIRED_FOR_WITHDRAW,
                message: `Withdrawal above Rp ${app_constants_1.WALLET_KYC_FREE_LIMIT.toLocaleString('id-ID')} requires KYC verification. Please verify your identity first.`,
            });
        }
        const walletCheck = await this.prisma.wallet.findUnique({ where: { userId } });
        if (!walletCheck)
            throw new common_1.NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Wallet not found' });
        if (walletCheck.isLocked) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.WALLET_LOCKED, message: 'Wallet is locked' });
        }
        await this.verifyWalletPin(walletCheck, pin, userId, ip);
        const minWithdraw = (0, currency_util_1.toSen)(this.minWithdraw);
        const maxWithdrawPerTx = (0, currency_util_1.toSen)(this.maxWithdrawPerTx);
        const amountInSen = (0, currency_util_1.toSen)(amount);
        if (amountInSen < minWithdraw) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.BELOW_MINIMUM_WITHDRAW,
                message: 'Amount below minimum withdrawal',
            });
        }
        if (amountInSen > maxWithdrawPerTx) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.ABOVE_MAXIMUM_WITHDRAW,
                message: `Per-transaction withdrawal limit is Rp ${this.maxWithdrawPerTx.toLocaleString('id-ID')}`,
            });
        }
        const bankAccount = await this.prisma.bankAccount.findFirst({
            where: { id: bankAccountId, userId, deletedAt: null },
        });
        if (!bankAccount)
            throw new common_1.NotFoundException({
                code: ErrorCodes.BANK_ACCOUNT_NOT_FOUND,
                message: 'Bank account not found',
            });
        if (!bankAccount.isVerified)
            throw new common_1.BadRequestException({
                code: ErrorCodes.BANK_ACCOUNT_NOT_VERIFIED,
                message: 'Bank account must be verified before withdrawal',
            });
        const withdrawLockKey = (0, redis_keys_1.WALLET_LOCK)(userId);
        const withdrawLockToken = `withdraw:${Date.now()}:${(0, crypto_1.randomBytes)(16).toString('hex')}`;
        const withdrawLockAcquired = await this.redis.setNx(withdrawLockKey, withdrawLockToken, WITHDRAW_LIFECYCLE_LOCK_TTL_SECONDS);
        if (!withdrawLockAcquired) {
            throw new common_1.ConflictException({
                code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                message: 'Another wallet operation is in progress. Please try again.',
            });
        }
        let walletTxId;
        let plainAccountNumber;
        try {
            walletTxId = (0, id_generator_util_1.generateWalletTxId)(await this.getNextWalletTxSerial());
            const MAX_RETRIES = 3;
            let lastError;
            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                    await this.prisma.$transaction(async (tx) => {
                        const lockedRows = await tx.$queryRaw `SELECT id FROM wallets WHERE id = ${walletCheck.id} FOR UPDATE`;
                        const lockedWallet = await tx.wallet.findUnique({ where: { id: walletCheck.id } });
                        if (!lockedWallet || lockedRows.length === 0) {
                            throw new common_1.NotFoundException({
                                code: ErrorCodes.NOT_FOUND,
                                message: 'Wallet not found',
                            });
                        }
                        if (lockedWallet.isLocked) {
                            throw new common_1.ForbiddenException({
                                code: ErrorCodes.WALLET_LOCKED,
                                message: 'Wallet is locked',
                            });
                        }
                        const pendingOtpWithdrawal = await tx.walletTransaction.findFirst({
                            where: {
                                walletId: lockedWallet.id,
                                type: client_1.WalletTransactionType.WITHDRAW,
                                status: client_1.WalletTransactionStatus.PENDING,
                                withdrawStatus: client_1.WithdrawStatus.PENDING_OTP,
                            },
                            select: { txId: true },
                        });
                        if (pendingOtpWithdrawal) {
                            throw new common_1.ConflictException({
                                code: ErrorCodes.BANK_ACCOUNT_HAS_PENDING_WITHDRAWAL,
                                message: 'A withdrawal is already awaiting OTP confirmation. Confirm or cancel it before starting another withdrawal.',
                            });
                        }
                        const verifiedBankAccount = await tx.bankAccount.findFirst({
                            where: { id: bankAccountId, userId, deletedAt: null },
                        });
                        if (!verifiedBankAccount) {
                            throw new common_1.NotFoundException({
                                code: ErrorCodes.BANK_ACCOUNT_NOT_FOUND,
                                message: 'Bank account not found or no longer belongs to user',
                            });
                        }
                        if (!verifiedBankAccount.isVerified) {
                            throw new common_1.BadRequestException({
                                code: ErrorCodes.BANK_ACCOUNT_NOT_VERIFIED,
                                message: 'Bank account must remain verified before withdrawal',
                            });
                        }
                        plainAccountNumber = await (0, crypto_util_1.decryptAES)(verifiedBankAccount.accountNumber);
                        const todayStartWib = (0, date_util_1.startOfDayWIB)();
                        const effectiveWithdraw = lockedWallet.lastLimitResetAt && lockedWallet.lastLimitResetAt < todayStartWib
                            ? BigInt(0)
                            : lockedWallet.todayWithdrawAmount;
                        const newWithdrawAmount = effectiveWithdraw + amountInSen;
                        const dailyLimit = (0, currency_util_1.toSen)(this.dailyWithdrawLimit);
                        if (newWithdrawAmount > dailyLimit) {
                            this.logger.warn(`WITHDRAW_REJECTED wallet=${walletCheck.id} user=${userId} reason=daily_limit_exceeded amount=${amountInSen} todayTotal=${effectiveWithdraw} limit=${dailyLimit} ip=${ip ?? 'unknown'}`);
                            throw new common_1.BadRequestException({
                                code: ErrorCodes.DAILY_WITHDRAW_LIMIT_EXCEEDED,
                                message: 'Daily withdrawal limit exceeded',
                            });
                        }
                        const heldAmount = await this.getHeldEscrowReleaseAmount(tx, lockedWallet.id);
                        const withdrawableBalance = lockedWallet.availableBalance - heldAmount;
                        if (withdrawableBalance < amountInSen) {
                            this.logger.warn(`WITHDRAW_REJECTED wallet=${walletCheck.id} user=${userId} reason=insufficient_withdrawable amount=${amountInSen} withdrawable=${withdrawableBalance} held=${heldAmount} ip=${ip ?? 'unknown'}`);
                            throw new common_1.BadRequestException({
                                code: ErrorCodes.INSUFFICIENT_BALANCE,
                                message: 'Insufficient withdrawable balance. Some funds from recent order completions are still in a holding period.',
                            });
                        }
                        const needsLazyReset = lockedWallet.lastLimitResetAt && lockedWallet.lastLimitResetAt < todayStartWib;
                        const withdrawUpdateData = needsLazyReset
                            ? {
                                availableBalance: { decrement: amountInSen },
                                totalBalance: { decrement: amountInSen },
                                todayTopupAmount: BigInt(0),
                                todayWithdrawAmount: amountInSen,
                                lastLimitResetAt: new Date(),
                                version: { increment: 1 },
                            }
                            : {
                                availableBalance: { decrement: amountInSen },
                                totalBalance: { decrement: amountInSen },
                                todayWithdrawAmount: { increment: amountInSen },
                                version: { increment: 1 },
                            };
                        const updated = await tx.wallet.updateMany({
                            where: {
                                id: walletCheck.id,
                                version: lockedWallet.version,
                                availableBalance: { gte: amountInSen },
                            },
                            data: withdrawUpdateData,
                        });
                        if (updated.count === 0) {
                            throw new common_1.ConflictException({
                                code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                                message: 'Concurrent update detected, please retry',
                            });
                        }
                        const sanitizedBankName = (verifiedBankAccount.bankName ?? '')
                            .replace(/[^\w\s\-&.]/g, '')
                            .slice(0, 50);
                        await tx.walletTransaction.create({
                            data: {
                                txId: walletTxId,
                                walletId: walletCheck.id,
                                type: client_1.WalletTransactionType.WITHDRAW,
                                status: client_1.WalletTransactionStatus.PENDING,
                                amount: amountInSen,
                                balanceBefore: lockedWallet.totalBalance,
                                balanceAfter: lockedWallet.totalBalance - amountInSen,
                                bankAccountId,
                                withdrawStatus: client_1.WithdrawStatus.PENDING_OTP,
                                description: `Withdrawal to ${sanitizedBankName} ****${plainAccountNumber.slice(-4)}`,
                            },
                        });
                    }, {
                        isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable,
                        maxWait: 10000,
                        timeout: 15000,
                    });
                    lastError = null;
                    break;
                }
                catch (err) {
                    lastError = err;
                    const isRetryable = this.isRetryableDbError(err);
                    if (!isRetryable || attempt === MAX_RETRIES) {
                        this.logger.error(`WITHDRAW_TX_FAILED wallet=${walletCheck.id} user=${userId} attempt=${attempt}/${MAX_RETRIES} retryable=${isRetryable}`, err instanceof Error ? err.stack : String(err));
                        break;
                    }
                    this.logger.warn(`WITHDRAW_TX_RETRY wallet=${walletCheck.id} user=${userId} attempt=${attempt}/${MAX_RETRIES}`);
                    await new Promise(resolve => setTimeout(resolve, 100 * attempt));
                }
            }
            if (lastError) {
                throw lastError;
            }
        }
        finally {
            await this.redis
                .releaseLock(withdrawLockKey, withdrawLockToken)
                .catch((error) => this.logger.warn(`WITHDRAW lock release failed: ${error instanceof Error ? error.message : String(error)}`));
        }
        let otp;
        try {
            await this.otpService.invalidateOtps(user.email ?? '', client_2.OtpType.WITHDRAW_CONFIRMATION);
            otp = await this.otpService.generateOtp(user.email ?? '', client_2.OtpType.WITHDRAW_CONFIRMATION, userId, { walletTxId, amountSen: amountInSen.toString(), bankAccountId, timestamp: Date.now() }, ip);
            await this.emailQueue.add('send', {
                to: user.email ?? '',
                subject: 'Kahade - Withdrawal Confirmation Code',
                templateName: 'withdrawal-otp',
                templateContext: { otp },
            }, {
                attempts: 3,
                backoff: { type: 'exponential', delay: 5000 },
                removeOnComplete: true,
                removeOnFail: 50,
            });
        }
        catch (otpError) {
            this.logger.error(`WITHDRAW_OTP_SETUP_FAILED txId=${walletTxId}; compensating reservation`, otpError instanceof Error ? otpError.stack : String(otpError));
            try {
                await this.cancelPendingWithdrawal(userId, walletTxId);
            }
            catch (compensationError) {
                this.logger.error(`CRITICAL: withdrawal reservation compensation failed txId=${walletTxId}: ${compensationError instanceof Error ? compensationError.message : String(compensationError)}`);
            }
            throw otpError;
        }
        await this.redis.setNx((0, redis_keys_1.WITHDRAW_OTP_COOLDOWN)(userId), '1', 60).catch(cooldownError => {
            this.logger.warn(`Withdrawal OTP cooldown could not be recorded for txId=${walletTxId}: ${cooldownError instanceof Error ? cooldownError.message : String(cooldownError)}`);
        });
        this.runRealtimeBestEffort(() => this.realtime.emitToUser(userId, 'wallet.balance_updated', { userId }), 'WITHDRAW_RESERVATION_BALANCE');
        this.auditLog.logUserAction({
            userId,
            action: client_2.UserAuditAction.WITHDRAW_REQUESTED,
            entityType: 'WalletTransaction',
            entityId: walletTxId,
            description: `User requested withdrawal of ${amount} to bank account ${bankAccountId}`,
        });
        return {
            withdrawTxId: walletTxId,
            amount,
            bankAccount: { masked: `****${plainAccountNumber.slice(-4)}` },
            otpExpiredAt: new Date(Date.now() +
                (this.configService.get('app.otpExpiresMinutes') ?? app_constants_1.OTP_EXPIRES_MINUTES) *
                    60 *
                    1000),
        };
    }
    async cancelPendingWithdrawal(userId, txId) {
        const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
        if (!wallet)
            throw new common_1.NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Wallet not found' });
        const walletTx = await this.prisma.walletTransaction.findFirst({
            where: {
                txId,
                walletId: wallet.id,
                type: client_1.WalletTransactionType.WITHDRAW,
                status: client_1.WalletTransactionStatus.PENDING,
                withdrawStatus: client_1.WithdrawStatus.PENDING_OTP,
            },
        });
        if (!walletTx) {
            throw new common_1.NotFoundException({
                code: ErrorCodes.NOT_FOUND,
                message: 'No pending withdrawal found with this ID',
            });
        }
        const cancelLockKey = (0, redis_keys_1.WALLET_LOCK)(userId);
        const cancelLockToken = `cancel:${Date.now()}:${(0, crypto_1.randomBytes)(16).toString('hex')}`;
        const cancelLockAcquired = await this.redis.setNx(cancelLockKey, cancelLockToken, WITHDRAW_LIFECYCLE_LOCK_TTL_SECONDS);
        if (!cancelLockAcquired) {
            throw new common_1.ConflictException({
                code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                message: 'Another wallet operation is in progress. Please try again.',
            });
        }
        try {
            let cancelLastError;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    await this.prisma.$transaction(async (tx) => {
                        const freshWithdrawal = await tx.walletTransaction.findFirst({
                            where: {
                                id: walletTx.id,
                                walletId: wallet.id,
                                type: client_1.WalletTransactionType.WITHDRAW,
                                status: client_1.WalletTransactionStatus.PENDING,
                                withdrawStatus: client_1.WithdrawStatus.PENDING_OTP,
                            },
                            select: { id: true, amount: true, createdAt: true },
                        });
                        if (!freshWithdrawal) {
                            throw new common_1.ConflictException({
                                code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                                message: 'Withdrawal already processed or cancelled',
                            });
                        }
                        const claimed = await tx.walletTransaction.updateMany({
                            where: {
                                id: freshWithdrawal.id,
                                type: client_1.WalletTransactionType.WITHDRAW,
                                status: client_1.WalletTransactionStatus.PENDING,
                                withdrawStatus: client_1.WithdrawStatus.PENDING_OTP,
                            },
                            data: {
                                withdrawStatus: client_1.WithdrawStatus.FAILED,
                                status: client_1.WalletTransactionStatus.FAILED,
                            },
                        });
                        if (claimed.count === 0) {
                            throw new common_1.ConflictException({
                                code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                                message: 'Withdrawal already processed or cancelled',
                            });
                        }
                        const todayStartWib = (0, date_util_1.startOfDayWIB)();
                        const isToday = freshWithdrawal.createdAt >= todayStartWib;
                        const freshWallet = await tx.$queryRaw `
              SELECT id, version, "isLocked" FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
                        if (!freshWallet.length) {
                            throw new common_1.ConflictException({
                                code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                                message: 'Wallet not found',
                            });
                        }
                        if (freshWallet[0].isLocked) {
                            throw new common_1.ForbiddenException({
                                code: ErrorCodes.WALLET_LOCKED,
                                message: 'Wallet is locked and cannot refund a pending withdrawal',
                            });
                        }
                        const walletUpdate = await tx.wallet.updateMany({
                            where: { id: wallet.id, version: freshWallet[0].version },
                            data: {
                                availableBalance: { increment: freshWithdrawal.amount },
                                totalBalance: { increment: freshWithdrawal.amount },
                                ...(isToday
                                    ? { todayWithdrawAmount: { decrement: freshWithdrawal.amount } }
                                    : {}),
                                version: { increment: 1 },
                            },
                        });
                        if (walletUpdate.count === 0) {
                            throw new common_1.ConflictException({
                                code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                                message: 'Wallet was modified concurrently, please retry',
                            });
                        }
                    }, {
                        isolationLevel: client_1.Prisma.TransactionIsolationLevel.RepeatableRead,
                        maxWait: 10000,
                        timeout: 15000,
                    });
                    cancelLastError = null;
                    break;
                }
                catch (err) {
                    cancelLastError = err;
                    if (!this.isRetryableDbError(err) || attempt === 3)
                        break;
                    this.logger.warn(`CANCEL_WITHDRAW_TX_RETRY wallet=${wallet.id} txId=${txId} attempt=${attempt}/3`);
                    await new Promise(resolve => setTimeout(resolve, 100 * attempt));
                }
            }
            if (cancelLastError)
                throw cancelLastError;
        }
        finally {
            await this.redis
                .releaseLock(cancelLockKey, cancelLockToken)
                .catch(err => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
        }
        this.runRealtimeBestEffort(() => this.realtime.emitToUser(userId, 'wallet.balance_updated', { userId }), 'CANCEL_WITHDRAW_BALANCE');
        this.auditLog.logUserAction({
            userId,
            action: client_2.UserAuditAction.WITHDRAW_CANCELLED,
            entityType: 'WalletTransaction',
            entityId: txId,
            description: `User cancelled pending withdrawal ${txId}`,
        });
        return { message: 'Pending withdrawal cancelled and funds restored' };
    }
    async transfer(senderId, recipientId, amount, pin, note, ip) {
        if (senderId === recipientId) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.CANNOT_TRANSFER_SELF,
                message: 'Cannot transfer to yourself',
            });
        }
        const [sender, recipient] = await Promise.all([
            this.prisma.user.findUnique({
                where: { id: senderId },
                select: {
                    id: true,
                    userId: true,
                    fullName: true,
                    email: true,
                    kycStatus: true,
                    isActive: true,
                    isBanned: true,
                    deletedAt: true,
                },
            }),
            this.prisma.user.findFirst({
                where: {
                    OR: [{ id: recipientId }, { userId: recipientId }, { username: recipientId }],
                    deletedAt: null,
                },
                select: {
                    id: true,
                    userId: true,
                    fullName: true,
                    username: true,
                    email: true,
                    kycStatus: true,
                    isActive: true,
                    isBanned: true,
                },
            }),
        ]);
        if (!sender)
            throw new common_1.NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Sender not found' });
        if (!sender.isActive || sender.isBanned || sender.deletedAt != null) {
            throw new common_1.ForbiddenException({
                code: ErrorCodes.ACCOUNT_INACTIVE,
                message: 'Sender account is not active',
            });
        }
        if (!recipient)
            throw new common_1.NotFoundException({
                code: ErrorCodes.RECIPIENT_NOT_FOUND,
                message: 'Recipient not found',
            });
        if (!recipient.isActive || recipient.isBanned) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.RECIPIENT_NOT_FOUND,
                message: 'Recipient account is not active',
            });
        }
        if (sender.id === recipient.id) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.CANNOT_TRANSFER_SELF,
                message: 'Cannot transfer to yourself',
            });
        }
        if (sender.kycStatus !== client_1.KycStatus.APPROVED) {
            throw new common_1.ForbiddenException({
                code: ErrorCodes.SENDER_KYC_REQUIRED,
                message: 'KYC verification is required before sending transfers',
            });
        }
        const senderWallet = await this.prisma.wallet.findUnique({ where: { userId: sender.id } });
        if (!senderWallet)
            throw new common_1.NotFoundException({
                code: ErrorCodes.WALLET_NOT_FOUND,
                message: 'Sender wallet not found',
            });
        if (senderWallet.isLocked)
            throw new common_1.ForbiddenException({
                code: ErrorCodes.WALLET_LOCKED,
                message: 'Your wallet is locked',
            });
        const recipientWallet = await this.prisma.wallet.findUnique({
            where: { userId: recipient.id },
        });
        if (!recipientWallet)
            throw new common_1.NotFoundException({
                code: ErrorCodes.RECIPIENT_NOT_FOUND,
                message: 'Recipient wallet not found',
            });
        if (recipientWallet.isLocked)
            throw new common_1.ForbiddenException({
                code: ErrorCodes.RECIPIENT_WALLET_LOCKED,
                message: 'Recipient wallet is currently locked',
            });
        if (!Number.isFinite(amount) ||
            !Number.isInteger(amount) ||
            amount <= 0 ||
            amount > Number.MAX_SAFE_INTEGER / 100) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.VALIDATION_ERROR,
                message: 'Transfer amount must be a finite positive whole IDR amount within the supported range',
            });
        }
        const amountInSen = (0, currency_util_1.toSen)(amount);
        const minTransfer = (0, currency_util_1.toSen)(app_constants_1.WALLET_MIN_TRANSFER);
        const maxTransfer = (0, currency_util_1.toSen)(app_constants_1.WALLET_MAX_TRANSFER_PER_TX);
        if (amountInSen < minTransfer) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.BELOW_MINIMUM_TRANSFER,
                message: `Minimum transfer is Rp ${app_constants_1.WALLET_MIN_TRANSFER.toLocaleString('id-ID')}`,
            });
        }
        if (amountInSen > maxTransfer) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.ABOVE_MAXIMUM_TRANSFER,
                message: `Maximum per-transaction transfer is Rp ${app_constants_1.WALLET_MAX_TRANSFER_PER_TX.toLocaleString('id-ID')}`,
            });
        }
        await this.verifyWalletPin(senderWallet, pin, sender.id, ip);
        const transferLockKey = (0, redis_keys_1.TRANSFER_LOCK)(sender.id);
        const transferLockToken = `transfer:${Date.now()}:${(0, crypto_1.randomBytes)(16).toString('hex')}`;
        const lockAcquired = await this.redis.setNx(transferLockKey, transferLockToken, 30);
        if (!lockAcquired) {
            throw new common_1.ConflictException({
                code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                message: 'Another wallet operation is in progress. Please try again.',
            });
        }
        const safeNote = typeof note === 'string'
            ? note
                .replace(/[\u0000-\u001F\u007F]/g, ' ')
                .trim()
                .slice(0, 200)
            : '';
        const safeRecipientName = recipient.fullName
            .replace(/[\u0000-\u001F\u007F]/g, ' ')
            .trim()
            .slice(0, 120);
        const safeSenderName = sender.fullName
            .replace(/[\u0000-\u001F\u007F]/g, ' ')
            .trim()
            .slice(0, 120);
        const description = safeNote
            ? `Transfer to ${safeRecipientName}: ${safeNote}`
            : `Transfer to ${safeRecipientName}`;
        const receiveDescription = safeNote
            ? `Transfer from ${safeSenderName}: ${safeNote}`
            : `Transfer from ${safeSenderName}`;
        let sentTxId;
        let receivedTxId;
        try {
            const today = (0, date_util_1.formatWIBDate)();
            const dailyKey = (0, redis_keys_1.DAILY_TRANSFER_AMOUNT)(sender.id, today);
            const dailyLimitSen = (0, currency_util_1.toSen)(app_constants_1.WALLET_DAILY_TRANSFER_LIMIT);
            const amountAsNumber = Number(amountInSen);
            if (!Number.isSafeInteger(amountAsNumber)) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.VALIDATION_ERROR,
                    message: `Transfer amount exceeds safe integer range for daily counter`,
                });
            }
            const newDailyTotal = await this.redis.incrBy(dailyKey, amountAsNumber);
            const ttlExists = await this.redis.ttl(dailyKey);
            if (ttlExists < 0) {
                const nowMs = Date.now();
                const ttlSec = Math.max(Math.ceil(((0, date_util_1.endOfDayWIB)(new Date(nowMs)).getTime() - nowMs) / 1000), 60);
                try {
                    await this.redis.expire(dailyKey, ttlSec);
                }
                catch (ttlError) {
                    await this.redis
                        .decrBy(dailyKey, amountAsNumber)
                        .catch(rollbackError => this.logger.error(`Failed to rollback daily transfer counter after TTL setup failure: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`));
                    throw ttlError;
                }
            }
            if (BigInt(newDailyTotal) > dailyLimitSen) {
                await this.redis
                    .decrBy(dailyKey, amountAsNumber)
                    .catch(err => this.logger.error(`Failed to rollback daily transfer counter: ${err.message}`));
                throw new common_1.BadRequestException({
                    code: ErrorCodes.DAILY_TRANSFER_LIMIT_EXCEEDED,
                    message: `Daily transfer limit of Rp ${app_constants_1.WALLET_DAILY_TRANSFER_LIMIT.toLocaleString('id-ID')} exceeded`,
                });
            }
            let dailyCounterRolledBack = false;
            try {
                const sentSerial = await this.getNextWalletTxSerial();
                const receivedSerial = await this.getNextWalletTxSerial();
                sentTxId = (0, id_generator_util_1.generateWalletTxId)(sentSerial);
                receivedTxId = (0, id_generator_util_1.generateWalletTxId)(receivedSerial);
            }
            catch (serialError) {
                dailyCounterRolledBack = true;
                await this.redis
                    .decrBy(dailyKey, amountAsNumber)
                    .catch(rollbackError => this.logger.error(`Failed to rollback daily transfer counter after serial allocation failure: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`));
                throw serialError;
            }
            const MAX_RETRIES = 3;
            let lastError;
            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                    await this.prisma.$transaction(async (tx) => {
                        const [firstId, secondId] = [senderWallet.id, recipientWallet.id].sort();
                        await tx.$queryRaw `SELECT id FROM wallets WHERE id IN (${firstId}, ${secondId}) ORDER BY id FOR UPDATE`;
                        const senderLocked = await tx.wallet.findUnique({ where: { id: senderWallet.id } });
                        if (!senderLocked)
                            throw new common_1.NotFoundException({
                                code: ErrorCodes.WALLET_NOT_FOUND,
                                message: 'Sender wallet not found',
                            });
                        if (senderLocked.isLocked)
                            throw new common_1.ForbiddenException({
                                code: ErrorCodes.WALLET_LOCKED,
                                message: 'Your wallet is locked',
                            });
                        if (senderLocked.availableBalance < amountInSen) {
                            throw new common_1.BadRequestException({
                                code: ErrorCodes.INSUFFICIENT_BALANCE,
                                message: 'Insufficient balance for transfer',
                            });
                        }
                        const recipientLocked = await tx.wallet.findUnique({
                            where: { id: recipientWallet.id },
                        });
                        if (!recipientLocked)
                            throw new common_1.NotFoundException({
                                code: ErrorCodes.RECIPIENT_NOT_FOUND,
                                message: 'Recipient wallet not found',
                            });
                        if (recipientLocked.isLocked)
                            throw new common_1.ForbiddenException({
                                code: ErrorCodes.RECIPIENT_WALLET_LOCKED,
                                message: 'Recipient wallet is currently locked',
                            });
                        const senderUpdated = await tx.wallet.updateMany({
                            where: {
                                id: senderWallet.id,
                                version: senderLocked.version,
                                availableBalance: { gte: amountInSen },
                            },
                            data: {
                                availableBalance: { decrement: amountInSen },
                                totalBalance: { decrement: amountInSen },
                                version: { increment: 1 },
                            },
                        });
                        if (senderUpdated.count === 0) {
                            throw new common_1.ConflictException({
                                code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                                message: 'Concurrent update detected, please retry',
                            });
                        }
                        const recipientUpdated = await tx.wallet.updateMany({
                            where: { id: recipientWallet.id, version: recipientLocked.version },
                            data: {
                                availableBalance: { increment: amountInSen },
                                totalBalance: { increment: amountInSen },
                                version: { increment: 1 },
                            },
                        });
                        if (recipientUpdated.count === 0) {
                            throw new common_1.ConflictException({
                                code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                                message: 'Concurrent update on recipient wallet detected, please retry',
                            });
                        }
                        await tx.walletTransaction.create({
                            data: {
                                txId: sentTxId,
                                walletId: senderWallet.id,
                                type: client_1.WalletTransactionType.TRANSFER_SENT,
                                status: client_1.WalletTransactionStatus.SUCCESS,
                                amount: amountInSen,
                                balanceBefore: senderLocked.availableBalance,
                                balanceAfter: senderLocked.availableBalance - amountInSen,
                                description,
                                metadata: {
                                    recipientId: recipient.id,
                                    recipientUserId: recipient.userId,
                                    recipientName: recipient.fullName,
                                    note: note || null,
                                    linkedTxId: receivedTxId,
                                },
                            },
                        });
                        await tx.walletTransaction.create({
                            data: {
                                txId: receivedTxId,
                                walletId: recipientWallet.id,
                                type: client_1.WalletTransactionType.TRANSFER_RECEIVED,
                                status: client_1.WalletTransactionStatus.SUCCESS,
                                amount: amountInSen,
                                balanceBefore: recipientLocked.availableBalance,
                                balanceAfter: recipientLocked.availableBalance + amountInSen,
                                description: receiveDescription,
                                metadata: {
                                    senderId: sender.id,
                                    senderUserId: sender.userId,
                                    senderName: sender.fullName,
                                    note: note || null,
                                    linkedTxId: sentTxId,
                                },
                            },
                        });
                    }, {
                        isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable,
                        maxWait: 10000,
                        timeout: 15000,
                    });
                    lastError = null;
                    break;
                }
                catch (err) {
                    lastError = err;
                    const isRetryable = this.isRetryableDbError(err);
                    if (!isRetryable || attempt === MAX_RETRIES) {
                        this.logger.error(`TRANSFER_TX_FAILED sender=${sender.userId} recipient=${recipient.userId} attempt=${attempt}/${MAX_RETRIES} retryable=${isRetryable}`, err instanceof Error ? err.stack : String(err));
                        break;
                    }
                    this.logger.warn(`TRANSFER_TX_RETRY sender=${sender.userId} recipient=${recipient.userId} attempt=${attempt}/${MAX_RETRIES}`);
                    const jitter = (0, crypto_1.randomInt)(0, 50);
                    await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, attempt - 1) + jitter));
                }
            }
            if (lastError) {
                if (!dailyCounterRolledBack) {
                    dailyCounterRolledBack = true;
                    await this.redis
                        .decrBy(dailyKey, amountAsNumber)
                        .catch(err => this.logger.error(`Failed to rollback daily transfer counter after DB failure: ${err.message}`));
                }
                throw lastError;
            }
            this.prisma.notification
                .createMany({
                data: [
                    {
                        notifId: (0, id_generator_util_1.generateNotifId)(),
                        userId: sender.id,
                        type: client_1.NotificationType.WALLET_TRANSFER_SENT,
                        category: (0, notification_category_map_1.getCategoryForType)(client_1.NotificationType.WALLET_TRANSFER_SENT),
                        title: 'Transfer Terkirim',
                        body: `Anda mengirim Rp ${amount.toLocaleString('id-ID')} ke ${recipient.fullName}`,
                        metadata: { txId: sentTxId, amount, recipientName: recipient.fullName },
                    },
                    {
                        notifId: (0, id_generator_util_1.generateNotifId)(),
                        userId: recipient.id,
                        type: client_1.NotificationType.WALLET_TRANSFER_RECEIVED,
                        category: (0, notification_category_map_1.getCategoryForType)(client_1.NotificationType.WALLET_TRANSFER_RECEIVED),
                        title: 'Transfer Diterima',
                        body: `Anda menerima Rp ${amount.toLocaleString('id-ID')} dari ${sender.fullName}`,
                        metadata: { txId: receivedTxId, amount, senderName: sender.fullName },
                    },
                ],
            })
                .catch((err) => this.logger.warn(`silent-catch: transfer notification failed: ${err instanceof Error ? err.message : String(err)}`));
            this.runRealtimeBestEffort(() => this.realtime.emitToUser(sender.id, 'wallet.balance_updated', { userId: sender.id }), 'TRANSFER_SENDER_BALANCE');
            this.runRealtimeBestEffort(() => this.realtime.emitToUser(recipient.id, 'wallet.balance_updated', {
                userId: recipient.id,
            }), 'TRANSFER_RECIPIENT_BALANCE');
            this.runRealtimeBestEffort(() => this.realtime.emitToUser(recipient.id, 'notification.new', {
                type: 'WALLET_TRANSFER_RECEIVED',
            }), 'TRANSFER_NOTIFICATION_PUSH');
            this.auditLog.logUserAction({
                userId: sender.id,
                action: client_2.UserAuditAction.TRANSFER_SENT,
                entityType: 'wallet',
                entityId: sentTxId,
                description: `Transfer sent Rp ${amount} to ${recipient.userId}`,
                after: {
                    amount,
                    recipientId: recipient.id,
                    recipientUserId: recipient.userId,
                    txId: sentTxId,
                },
                ipAddress: ip,
            });
            this.auditLog.logUserAction({
                userId: recipient.id,
                action: client_2.UserAuditAction.TRANSFER_RECEIVED,
                entityType: 'wallet',
                entityId: receivedTxId,
                description: `Transfer received Rp ${amount} from ${sender.userId}`,
                after: { amount, senderId: sender.id, senderUserId: sender.userId, txId: receivedTxId },
            });
            const sanitizeName = (n) => (n ?? '').replace(/[<>&"']/g, '').slice(0, 100);
            void Promise.resolve()
                .then(() => this.emailQueue.add('send', {
                to: sender.email ?? '',
                subject: `Transfer Berhasil - Rp ${amount.toLocaleString('id-ID')}`,
                templateName: 'transfer-sent',
                templateContext: {
                    name: sanitizeName(sender.fullName),
                    amount: `Rp ${amount.toLocaleString('id-ID')}`,
                    recipientName: sanitizeName(recipient.fullName),
                    txId: sentTxId,
                    date: new Date().toLocaleDateString('id-ID'),
                },
            }))
                .catch(err => this.logger.warn(`Failed to queue transfer email: ${err instanceof Error ? err.message : String(err)}`));
            void Promise.resolve()
                .then(() => this.emailQueue.add('send', {
                to: recipient.email ?? '',
                subject: `Transfer Diterima - Rp ${amount.toLocaleString('id-ID')}`,
                templateName: 'transfer-received',
                templateContext: {
                    name: sanitizeName(recipient.fullName),
                    amount: `Rp ${amount.toLocaleString('id-ID')}`,
                    senderName: sanitizeName(sender.fullName),
                    txId: receivedTxId,
                    date: new Date().toLocaleDateString('id-ID'),
                },
            }))
                .catch(err => this.logger.warn(`Failed to queue transfer email: ${err instanceof Error ? err.message : String(err)}`));
            this.logger.log(`TRANSFER_SUCCESS sender=${sender.userId} recipient=${recipient.userId} amount=${amount} sentTx=${sentTxId} receivedTx=${receivedTxId}`);
        }
        finally {
            try {
                await this.redis.releaseLock(transferLockKey, transferLockToken);
            }
            catch (error) {
                this.logger.warn(`TRANSFER lock release failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return {
            message: 'Transfer successful',
            txId: sentTxId,
            amount,
            recipient: {
                userId: recipient.userId,
                fullName: recipient.fullName,
                username: recipient.username,
            },
        };
    }
    async lookupTransferRecipient(query, senderId) {
        const user = await this.prisma.user.findFirst({
            where: {
                OR: [{ username: query }, { userId: query }],
                deletedAt: null,
                isActive: true,
                isBanned: false,
                id: { not: senderId },
            },
            select: { id: true, userId: true, fullName: true, username: true, avatarUrl: true },
        });
        if (!user)
            return null;
        return {
            id: user.id,
            userId: user.userId,
            fullName: user.fullName,
            username: user.username,
            avatarUrl: user.avatarUrl,
        };
    }
    async lockEscrowForOrder(walletId, amount, orderId) {
        if (amount <= BigInt(0)) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.VALIDATION_ERROR,
                message: 'Escrow lock amount must be greater than zero',
            });
        }
        let walletTxSerial = null;
        let walletTxId;
        await this.withWalletSerializableRetry(() => this.prisma.$transaction(async (tx) => {
            const existingLock = await tx.walletTransaction.findFirst({
                where: {
                    orderId,
                    walletId,
                    type: client_1.WalletTransactionType.ORDER_LOCK,
                    status: client_1.WalletTransactionStatus.SUCCESS,
                },
                select: { txId: true, amount: true },
            });
            if (existingLock) {
                if (existingLock.amount !== amount) {
                    throw new common_1.ConflictException({
                        code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                        message: 'Existing escrow lock amount differs from requested amount',
                    });
                }
                walletTxId = existingLock.txId;
                return;
            }
            await tx.$queryRaw `SELECT id FROM wallets WHERE id = ${walletId} FOR UPDATE`;
            const wallet = await tx.wallet.findUnique({ where: { id: walletId } });
            if (!wallet) {
                throw new common_1.NotFoundException({
                    code: ErrorCodes.NOT_FOUND,
                    message: 'Wallet not found',
                });
            }
            if (wallet.isLocked) {
                throw new common_1.ForbiddenException({
                    code: ErrorCodes.WALLET_LOCKED,
                    message: 'Wallet is locked and cannot fund escrow',
                });
            }
            if (wallet.availableBalance < amount) {
                this.logger.warn(`ESCROW_LOCK_REJECTED wallet=${walletId} order=${orderId} reason=insufficient_balance amount=${amount} available=${wallet.availableBalance}`);
                throw new common_1.BadRequestException({
                    code: ErrorCodes.INSUFFICIENT_BALANCE,
                    message: 'Insufficient available balance for escrow',
                });
            }
            const updated = await tx.wallet.updateMany({
                where: { id: walletId, version: wallet.version, availableBalance: { gte: amount } },
                data: {
                    availableBalance: { decrement: amount },
                    escrowBalance: { increment: amount },
                    version: { increment: 1 },
                },
            });
            if (updated.count === 0) {
                throw new common_1.ConflictException({
                    code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                    message: 'Concurrent update detected, please retry',
                });
            }
            const verifiedWallet = await tx.wallet.findUnique({
                where: { id: walletId },
                select: { availableBalance: true, escrowBalance: true },
            });
            if (verifiedWallet) {
                const expectedAvailable = wallet.availableBalance - amount;
                const expectedEscrow = wallet.escrowBalance + amount;
                if (verifiedWallet.availableBalance !== expectedAvailable ||
                    verifiedWallet.escrowBalance !== expectedEscrow) {
                    this.logger.error(`POST-TX BALANCE MISMATCH [escrow-lock] wallet=${walletId}: ` +
                        `expected available=${expectedAvailable} escrow=${expectedEscrow}, ` +
                        `actual available=${verifiedWallet.availableBalance} escrow=${verifiedWallet.escrowBalance}`);
                    throw new common_1.ConflictException({
                        code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                        message: 'Post-transaction balance verification failed',
                    });
                }
            }
            if (walletTxSerial === null)
                walletTxSerial = await this.getNextWalletTxSerial();
            walletTxId = (0, id_generator_util_1.generateWalletTxId)(walletTxSerial);
            await tx.walletTransaction.create({
                data: {
                    txId: walletTxId,
                    walletId,
                    type: client_1.WalletTransactionType.ORDER_LOCK,
                    status: client_1.WalletTransactionStatus.SUCCESS,
                    amount,
                    balanceBefore: wallet.availableBalance,
                    balanceAfter: wallet.availableBalance - amount,
                    orderId,
                    description: `Escrow lock for order ${orderId}`,
                },
            });
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable }), 'LOCK_ESCROW');
        const lockedWalletUser = await this.prisma.wallet.findUnique({
            where: { id: walletId },
            select: { userId: true },
        });
        if (lockedWalletUser) {
            this.runRealtimeBestEffort(() => this.realtime.emitToUser(lockedWalletUser.userId, 'wallet.balance_updated', {
                userId: lockedWalletUser.userId,
            }), 'LOCK_ESCROW_BALANCE');
        }
        return walletTxId;
    }
    async releaseEscrow(fromWalletId, toWalletId, amount, orderId) {
        if (amount <= BigInt(0)) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.VALIDATION_ERROR,
                message: 'Escrow release amount must be greater than zero',
            });
        }
        let releaseTxSerial = null;
        let receiveTxSerial = null;
        await this.withWalletSerializableRetry(() => this.prisma.$transaction(async (tx) => {
            const existingRelease = await tx.walletTransaction.findFirst({
                where: {
                    orderId,
                    walletId: fromWalletId,
                    type: client_1.WalletTransactionType.ORDER_RELEASE,
                    status: client_1.WalletTransactionStatus.SUCCESS,
                },
                select: { txId: true, amount: true },
            });
            const existingReceive = await tx.walletTransaction.findFirst({
                where: {
                    orderId,
                    walletId: toWalletId,
                    type: client_1.WalletTransactionType.ORDER_RELEASE,
                    status: client_1.WalletTransactionStatus.SUCCESS,
                },
                select: { txId: true, amount: true },
            });
            if (existingRelease || existingReceive) {
                if (!existingRelease ||
                    !existingReceive ||
                    existingRelease.amount !== amount ||
                    existingReceive.amount !== amount) {
                    throw new common_1.ConflictException({
                        code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                        message: 'Escrow release ledger pair is incomplete or has a different amount',
                    });
                }
                return;
            }
            const [firstId, secondId] = [fromWalletId, toWalletId].sort();
            await tx.$queryRaw `SELECT id FROM wallets WHERE id IN (${firstId}, ${secondId}) ORDER BY id FOR UPDATE`;
            const fromWallet = await tx.wallet.findUnique({ where: { id: fromWalletId } });
            if (!fromWallet) {
                throw new common_1.NotFoundException({
                    code: ErrorCodes.NOT_FOUND,
                    message: 'Source wallet not found',
                });
            }
            if (fromWallet.isLocked) {
                throw new common_1.ForbiddenException({
                    code: ErrorCodes.WALLET_LOCKED,
                    message: 'Source wallet is locked',
                });
            }
            if (fromWallet.escrowBalance < amount) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.INSUFFICIENT_BALANCE,
                    message: 'Insufficient escrow balance',
                });
            }
            const toWallet = await tx.wallet.findUnique({ where: { id: toWalletId } });
            if (!toWallet) {
                throw new common_1.NotFoundException({
                    code: ErrorCodes.NOT_FOUND,
                    message: 'Destination wallet not found',
                });
            }
            if (toWallet.isLocked) {
                throw new common_1.ForbiddenException({
                    code: ErrorCodes.RECIPIENT_WALLET_LOCKED,
                    message: 'Destination wallet is locked',
                });
            }
            if (releaseTxSerial === null)
                releaseTxSerial = await this.getNextWalletTxSerial();
            if (receiveTxSerial === null)
                receiveTxSerial = await this.getNextWalletTxSerial();
            const updated = await tx.wallet.updateMany({
                where: {
                    id: fromWalletId,
                    version: fromWallet.version,
                    escrowBalance: { gte: amount },
                },
                data: {
                    escrowBalance: { decrement: amount },
                    totalBalance: { decrement: amount },
                    version: { increment: 1 },
                },
            });
            if (updated.count === 0) {
                throw new common_1.ConflictException({
                    code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                    message: 'Concurrent escrow release detected, please retry',
                });
            }
            const toUpdated = await tx.wallet.updateMany({
                where: { id: toWalletId, version: toWallet.version },
                data: {
                    availableBalance: { increment: amount },
                    totalBalance: { increment: amount },
                    version: { increment: 1 },
                },
            });
            if (toUpdated.count === 0) {
                throw new common_1.ConflictException({
                    code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                    message: 'Concurrent update on destination wallet detected, please retry',
                });
            }
            const verifiedFrom = await tx.wallet.findUnique({
                where: { id: fromWalletId },
                select: { escrowBalance: true, totalBalance: true },
            });
            const verifiedTo = await tx.wallet.findUnique({
                where: { id: toWalletId },
                select: { availableBalance: true, totalBalance: true },
            });
            if (verifiedFrom) {
                const expectedEscrow = fromWallet.escrowBalance - amount;
                const expectedTotal = fromWallet.totalBalance - amount;
                if (verifiedFrom.escrowBalance !== expectedEscrow ||
                    verifiedFrom.totalBalance !== expectedTotal) {
                    this.logger.error(`POST-TX BALANCE MISMATCH [escrow-release-from] wallet=${fromWalletId}: ` +
                        `expected escrow=${expectedEscrow} total=${expectedTotal}, ` +
                        `actual escrow=${verifiedFrom.escrowBalance} total=${verifiedFrom.totalBalance}`);
                    throw new common_1.ConflictException({
                        code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                        message: 'Post-transaction balance verification failed',
                    });
                }
            }
            if (verifiedTo) {
                const expectedAvailable = toWallet.availableBalance + amount;
                const expectedTotal = toWallet.totalBalance + amount;
                if (verifiedTo.availableBalance !== expectedAvailable ||
                    verifiedTo.totalBalance !== expectedTotal) {
                    this.logger.error(`POST-TX BALANCE MISMATCH [escrow-release-to] wallet=${toWalletId}: ` +
                        `expected available=${expectedAvailable} total=${expectedTotal}, ` +
                        `actual available=${verifiedTo.availableBalance} total=${verifiedTo.totalBalance}`);
                    throw new common_1.ConflictException({
                        code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                        message: 'Post-transaction balance verification failed',
                    });
                }
            }
            const releaseTxId = (0, id_generator_util_1.generateWalletTxId)(releaseTxSerial);
            await tx.walletTransaction.create({
                data: {
                    txId: releaseTxId,
                    walletId: fromWalletId,
                    type: client_1.WalletTransactionType.ORDER_RELEASE,
                    status: client_1.WalletTransactionStatus.SUCCESS,
                    amount,
                    balanceBefore: fromWallet.totalBalance,
                    balanceAfter: fromWallet.totalBalance - amount,
                    orderId,
                    description: `Escrow release from order ${orderId}`,
                },
            });
            const receiveTxId = (0, id_generator_util_1.generateWalletTxId)(receiveTxSerial);
            await tx.walletTransaction.create({
                data: {
                    txId: receiveTxId,
                    walletId: toWalletId,
                    type: client_1.WalletTransactionType.ORDER_RELEASE,
                    status: client_1.WalletTransactionStatus.SUCCESS,
                    amount,
                    balanceBefore: toWallet.totalBalance,
                    balanceAfter: toWallet.totalBalance + amount,
                    orderId,
                    description: `Escrow received from order ${orderId}`,
                },
            });
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable }), 'RELEASE_ESCROW');
        const [fromUser, toUser] = await Promise.all([
            this.prisma.wallet.findUnique({ where: { id: fromWalletId }, select: { userId: true } }),
            this.prisma.wallet.findUnique({ where: { id: toWalletId }, select: { userId: true } }),
        ]);
        if (fromUser)
            this.runRealtimeBestEffort(() => this.realtime.emitToUser(fromUser.userId, 'wallet.balance_updated', {
                userId: fromUser.userId,
            }), 'RELEASE_ESCROW_SOURCE_BALANCE');
        if (toUser)
            this.runRealtimeBestEffort(() => this.realtime.emitToUser(toUser.userId, 'wallet.balance_updated', {
                userId: toUser.userId,
            }), 'RELEASE_ESCROW_DESTINATION_BALANCE');
    }
    async handleTopupSuccess(midtransOrderId, webhookGrossAmount) {
        const paymentTx = await this.prisma.paymentTransaction.findUnique({
            where: { midtransOrderId },
        });
        if (!paymentTx || paymentTx.status !== client_1.PaymentStatus.PENDING)
            return;
        if (webhookGrossAmount !== undefined) {
            const webhookAmountSen = this.parseProviderAmountToSen(webhookGrossAmount, 'gross_amount');
            const expectedGross = paymentTx.grossAmount > BigInt(0) ? paymentTx.grossAmount : paymentTx.amount;
            if (webhookAmountSen !== expectedGross) {
                this.logger.error(`CRITICAL: Webhook amount mismatch for ${midtransOrderId}. ` +
                    `Webhook: ${webhookGrossAmount} (${webhookAmountSen} sen), DB grossAmount: ${expectedGross} sen. ` +
                    `Rejecting credit to prevent fraud.`);
                throw new common_1.BadRequestException({
                    code: 'AMOUNT_MISMATCH',
                    message: 'Webhook gross_amount does not match stored transaction amount',
                });
            }
        }
        let walletTxSerial = null;
        const topupSettled = await this.withWalletSerializableRetry(() => this.prisma.$transaction(async (tx) => {
            const claimed = await tx.paymentTransaction.updateMany({
                where: { midtransOrderId, status: client_1.PaymentStatus.PENDING },
                data: { status: client_1.PaymentStatus.SUCCESS, settledAt: new Date() },
            });
            if (claimed.count === 0) {
                return false;
            }
            await tx.$queryRaw `SELECT id FROM wallets WHERE "userId" = ${paymentTx.userId} FOR UPDATE`;
            const wallet = await tx.wallet.findUnique({ where: { userId: paymentTx.userId } });
            if (!wallet) {
                throw new common_1.NotFoundException({
                    code: ErrorCodes.NOT_FOUND,
                    message: 'Wallet not found during top-up settlement',
                });
            }
            const amount = paymentTx.amount;
            const walletUpdated = await tx.wallet.updateMany({
                where: { id: wallet.id, version: wallet.version },
                data: {
                    availableBalance: { increment: amount },
                    totalBalance: { increment: amount },
                    lastTopupAt: new Date(),
                    version: { increment: 1 },
                },
            });
            if (walletUpdated.count === 0) {
                throw new common_1.ConflictException({
                    code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                    message: 'Concurrent wallet update detected, please retry',
                });
            }
            const verifiedWallet = await tx.wallet.findUnique({
                where: { id: wallet.id },
                select: { availableBalance: true, totalBalance: true },
            });
            if (verifiedWallet) {
                const expectedAvailable = wallet.availableBalance + amount;
                const expectedTotal = wallet.totalBalance + amount;
                if (verifiedWallet.availableBalance !== expectedAvailable ||
                    verifiedWallet.totalBalance !== expectedTotal) {
                    this.logger.error(`POST-TX BALANCE MISMATCH [topup] wallet=${wallet.id}: ` +
                        `expected available=${expectedAvailable} total=${expectedTotal}, ` +
                        `actual available=${verifiedWallet.availableBalance} total=${verifiedWallet.totalBalance}`);
                    throw new common_1.ConflictException({
                        code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                        message: 'Post-transaction balance verification failed',
                    });
                }
            }
            const pendingWalletTx = await tx.walletTransaction.findFirst({
                where: {
                    paymentTxId: paymentTx.id,
                    type: client_1.WalletTransactionType.TOP_UP,
                    status: client_1.WalletTransactionStatus.PENDING,
                },
            });
            if (pendingWalletTx) {
                await tx.walletTransaction.update({
                    where: { id: pendingWalletTx.id },
                    data: {
                        status: client_1.WalletTransactionStatus.SUCCESS,
                        balanceBefore: wallet.totalBalance,
                        balanceAfter: wallet.totalBalance + amount,
                    },
                });
            }
            else {
                if (walletTxSerial === null)
                    walletTxSerial = await this.getNextWalletTxSerial();
                const walletTxId = (0, id_generator_util_1.generateWalletTxId)(walletTxSerial);
                await tx.walletTransaction.create({
                    data: {
                        txId: walletTxId,
                        walletId: wallet.id,
                        type: client_1.WalletTransactionType.TOP_UP,
                        status: client_1.WalletTransactionStatus.SUCCESS,
                        amount,
                        balanceBefore: wallet.totalBalance,
                        balanceAfter: wallet.totalBalance + amount,
                        paymentTxId: paymentTx.id,
                        description: 'Top up settlement',
                    },
                });
            }
            return true;
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable }), 'TOPUP_SUCCESS');
        if (!topupSettled)
            return;
        const topupNotifTitle = 'Top-up Successful';
        const topupNotifBody = `Top-up of Rp ${(0, currency_util_1.toIdr)(paymentTx.amount).toLocaleString('id-ID')} has been credited to your wallet.`;
        this.prisma.notification
            .create({
            data: {
                notifId: (0, id_generator_util_1.generateNotifId)(),
                userId: paymentTx.userId,
                type: client_1.NotificationType.WALLET_TOPUP_SUCCESS,
                category: (0, notification_category_map_1.getCategoryForType)(client_1.NotificationType.WALLET_TOPUP_SUCCESS),
                title: topupNotifTitle,
                body: topupNotifBody,
                isRead: false,
            },
        })
            .catch((notificationError) => this.logger.warn(`silent-catch: top-up success notification failed: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}`));
        try {
            this.prisma.emitNotificationCreated({
                userId: paymentTx.userId,
                title: topupNotifTitle,
                body: topupNotifBody,
                data: { type: 'WALLET_TOPUP' },
            });
        }
        catch (error) {
            this.logger.warn(`Top-up success realtime notification failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.runRealtimeBestEffort(() => this.realtime.emitToUser(paymentTx.userId, 'wallet.balance_updated', {
            userId: paymentTx.userId,
        }), 'TOPUP_BALANCE');
        this.reconcileDailyTopups(paymentTx.userId).catch(err => {
            this.logger.warn(`Daily topup reconciliation check failed for user ${paymentTx.userId}: ${err.message}`);
        });
    }
    async reconcileDailyTopups(userId) {
        const todayStartWib = (0, date_util_1.startOfDayWIB)();
        const wallet = await this.prisma.wallet.findUnique({
            where: { userId },
            select: { todayTopupAmount: true },
        });
        if (!wallet)
            return;
        const successfulTopups = await this.prisma.walletTransaction.aggregate({
            where: {
                wallet: { userId },
                type: client_1.WalletTransactionType.TOP_UP,
                status: { in: [client_1.WalletTransactionStatus.SUCCESS, client_1.WalletTransactionStatus.PENDING] },
                createdAt: { gte: todayStartWib },
            },
            _sum: { amount: true },
        });
        const actualTotal = successfulTopups._sum.amount ?? BigInt(0);
        const counterTotal = wallet.todayTopupAmount;
        if (actualTotal !== counterTotal) {
            const delta = counterTotal - actualTotal;
            const msg = `RECONCILIATION MISMATCH for user ${userId}: daily counter=${counterTotal}n, actual successful topups=${actualTotal}n. Delta=${delta}n sen.`;
            this.logger.error(msg);
            this.redis
                .set(`alert:reconciliation_mismatch:${userId}:${(0, date_util_1.formatWIBDate)()}`, JSON.stringify({
                userId,
                counterTotal: counterTotal.toString(),
                actualTotal: actualTotal.toString(),
                delta: delta.toString(),
                detectedAt: new Date().toISOString(),
            }), 86400)
                .catch((e) => this.logger.warn(`Failed to store reconciliation mismatch alert: ${e.message}`));
        }
    }
    parseProviderAmountToSen(value, field) {
        if (!/^\d+(?:\.\d{1,2})?$/.test(value)) {
            throw new common_1.BadRequestException({
                code: 'INVALID_PROVIDER_AMOUNT',
                message: `${field} is not a valid IDR amount`,
            });
        }
        const [whole, fraction = ''] = value.split('.');
        return BigInt(whole) * BigInt(100) + BigInt((fraction + '00').slice(0, 2));
    }
    async handleTopupFailure(midtransOrderId, _reason = 'PAYMENT_FAILED', reversal) {
        const paymentTx = await this.prisma.paymentTransaction.findUnique({
            where: { midtransOrderId },
        });
        if (!paymentTx)
            return;
        const reasonCode = _reason.toUpperCase();
        const isPostSettlementReversal = [
            'REFUND',
            'PARTIAL_REFUND',
            'CHARGEBACK',
            'PARTIAL_CHARGEBACK',
        ].includes(reasonCode);
        if (paymentTx.status === client_1.PaymentStatus.SUCCESS && !isPostSettlementReversal) {
            this.logger.warn(`Ignoring stale non-reversal top-up event for settled order ${midtransOrderId} (reason: ${_reason})`);
            return;
        }
        const terminalPaymentStatus = isPostSettlementReversal
            ? client_1.PaymentStatus.REFUNDED
            : client_1.PaymentStatus.FAILED;
        const reversalSerial = paymentTx.status === client_1.PaymentStatus.SUCCESS && paymentTx.amount > BigInt(0)
            ? await this.walletTxSerialService.getNext()
            : null;
        if (paymentTx.status === client_1.PaymentStatus.PENDING) {
            const topupFailureClaimed = await this.withWalletSerializableRetry(() => this.prisma.$transaction(async (tx) => {
                const claimed = await tx.paymentTransaction.updateMany({
                    where: { midtransOrderId, status: client_1.PaymentStatus.PENDING },
                    data: { status: terminalPaymentStatus, failedAt: new Date() },
                });
                if (claimed.count === 0)
                    return false;
                await tx.walletTransaction.updateMany({
                    where: {
                        paymentTxId: paymentTx.id,
                        type: client_1.WalletTransactionType.TOP_UP,
                        status: client_1.WalletTransactionStatus.PENDING,
                    },
                    data: { status: client_1.WalletTransactionStatus.FAILED },
                });
                const wallet = await tx.wallet.findUnique({ where: { userId: paymentTx.userId } });
                if (wallet && paymentTx.createdAt >= (0, date_util_1.startOfDayWIB)()) {
                    const clampedDecrement = wallet.todayTopupAmount >= paymentTx.amount
                        ? paymentTx.amount
                        : wallet.todayTopupAmount;
                    const counterUpdated = await tx.wallet.updateMany({
                        where: { id: wallet.id, version: wallet.version },
                        data: {
                            todayTopupAmount: { decrement: clampedDecrement },
                            version: { increment: 1 },
                        },
                    });
                    if (counterUpdated.count === 0) {
                        throw new common_1.ConflictException({
                            code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                            message: 'Concurrent top-up counter update detected; retry webhook',
                        });
                    }
                }
                return true;
            }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable }), 'TOPUP_FAILURE');
            if (!topupFailureClaimed)
                return;
            this.prisma.notification
                .create({
                data: {
                    notifId: (0, id_generator_util_1.generateNotifId)(),
                    userId: paymentTx.userId,
                    type: client_1.NotificationType.WALLET_TOPUP_FAILED,
                    category: (0, notification_category_map_1.getCategoryForType)(client_1.NotificationType.WALLET_TOPUP_FAILED),
                    title: 'Top-up Failed',
                    body: `Top-up of Rp ${(0, currency_util_1.toIdr)(paymentTx.amount).toLocaleString('id-ID')} failed to process. Please try again.`,
                    isRead: false,
                },
            })
                .catch((notificationError) => this.logger.warn(`silent-catch: top-up failure notification failed: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}`));
            this.prisma.emitNotificationCreated({
                userId: paymentTx.userId,
                title: 'Top-up Failed',
                body: 'Top-up payment failed to process',
                data: { type: 'WALLET_TOPUP_FAILED' },
            });
        }
        else if (paymentTx.status === client_1.PaymentStatus.SUCCESS) {
            this.logger.warn(`Post-settlement reversal for order ${midtransOrderId} (reason: ${_reason})`);
            await this.withWalletSerializableRetry(() => this.prisma.$transaction(async (tx) => {
                await tx.$queryRaw `SELECT "id" FROM "payment_transactions" WHERE "id" = ${paymentTx.id} FOR UPDATE`;
                const currentPaymentTx = await tx.paymentTransaction.findUnique({
                    where: { id: paymentTx.id },
                });
                if (!currentPaymentTx || currentPaymentTx.status !== client_1.PaymentStatus.SUCCESS)
                    return;
                const isPartialRefund = reasonCode === 'PARTIAL_REFUND' || reasonCode === 'PARTIAL_CHARGEBACK';
                const isFullProviderReversal = reasonCode === 'REFUND' || reasonCode === 'CHARGEBACK';
                if (isPartialRefund && !reversal?.refundAmount) {
                    throw new common_1.BadRequestException({
                        code: 'REFUND_AMOUNT_REQUIRED',
                        message: 'partial refund notification is missing refund_amount',
                    });
                }
                const reportedRefundTotal = reversal?.refundAmount
                    ? this.parseProviderAmountToSen(reversal.refundAmount, 'refund_amount')
                    : currentPaymentTx.amount;
                if (reportedRefundTotal <= BigInt(0) ||
                    reportedRefundTotal > currentPaymentTx.amount) {
                    throw new common_1.BadRequestException({
                        code: 'INVALID_REFUND_AMOUNT',
                        message: 'Provider refund amount is outside the original payment amount',
                    });
                }
                if (isFullProviderReversal && reportedRefundTotal !== currentPaymentTx.amount) {
                    throw new common_1.BadRequestException({
                        code: 'INVALID_REFUND_AMOUNT',
                        message: 'Full refund amount does not match the original payment amount',
                    });
                }
                const alreadyRefunded = currentPaymentTx.refundedAmount ?? BigInt(0);
                const reversalAmount = reportedRefundTotal - alreadyRefunded;
                if (reversalAmount <= BigInt(0))
                    return;
                const fullyRefunded = reportedRefundTotal === currentPaymentTx.amount;
                const wallet = await tx.wallet.findUnique({ where: { userId: paymentTx.userId } });
                if (wallet && wallet.availableBalance >= reversalAmount) {
                    const adjustCurrentDayCounter = paymentTx.createdAt >= (0, date_util_1.startOfDayWIB)();
                    const clampedTopupDecrement = wallet.todayTopupAmount >= reversalAmount
                        ? reversalAmount
                        : wallet.todayTopupAmount;
                    const updated = await tx.wallet.updateMany({
                        where: { id: wallet.id, version: wallet.version },
                        data: {
                            availableBalance: { decrement: reversalAmount },
                            totalBalance: { decrement: reversalAmount },
                            ...(adjustCurrentDayCounter
                                ? { todayTopupAmount: { decrement: clampedTopupDecrement } }
                                : {}),
                            version: { increment: 1 },
                        },
                    });
                    if (updated.count === 0) {
                        this.logger.error(`Reversal for order ${midtransOrderId}: optimistic lock conflict on wallet ${wallet.id}; locking wallet`);
                        await tx.wallet.update({
                            where: { id: wallet.id },
                            data: {
                                isLocked: true,
                                lockReason: `Auto-locked: post-settlement reversal version conflict — could not debit ${reversalAmount} (order: ${midtransOrderId})`,
                                lockedAt: new Date(),
                                lockedBy: 'SYSTEM',
                            },
                        });
                        await tx.notification.create({
                            data: {
                                notifId: (0, id_generator_util_1.generateNotifId)(),
                                userId: paymentTx.userId,
                                type: client_1.NotificationType.SECURITY_ACCOUNT_LOCKED,
                                category: (0, notification_category_map_1.getCategoryForType)(client_1.NotificationType.SECURITY_ACCOUNT_LOCKED),
                                title: 'Wallet Locked',
                                body: 'Your wallet has been automatically locked due to a technical issue with your payment. Please contact customer support for assistance.',
                                isRead: false,
                            },
                        });
                    }
                    else if (reversalSerial !== null) {
                        const originalTopup = await tx.walletTransaction.findFirst({
                            where: {
                                paymentTxId: paymentTx.id,
                                type: client_1.WalletTransactionType.TOP_UP,
                                status: client_1.WalletTransactionStatus.SUCCESS,
                            },
                            orderBy: { createdAt: 'asc' },
                            select: { id: true },
                        });
                        const reversalTx = await tx.walletTransaction.create({
                            data: {
                                txId: (0, id_generator_util_1.generateWalletTxId)(reversalSerial),
                                walletId: wallet.id,
                                type: client_1.WalletTransactionType.ADMIN_DEBIT,
                                status: client_1.WalletTransactionStatus.SUCCESS,
                                amount: reversalAmount,
                                balanceBefore: wallet.availableBalance,
                                balanceAfter: wallet.availableBalance - reversalAmount,
                                paymentTxId: paymentTx.id,
                                description: `Top-up reversal (${reasonCode}) for ${midtransOrderId}`,
                                metadata: reversal?.refundReference
                                    ? {
                                        refundReference: reversal.refundReference,
                                        refundAmount: reportedRefundTotal.toString(),
                                    }
                                    : undefined,
                                completedAt: new Date(),
                            },
                        });
                        if (originalTopup && fullyRefunded) {
                            await tx.walletTransaction.update({
                                where: { id: originalTopup.id },
                                data: {
                                    status: client_1.WalletTransactionStatus.REVERSED,
                                    reversalTxId: reversalTx.id,
                                },
                            });
                        }
                        await tx.paymentTransaction.update({
                            where: { id: currentPaymentTx.id },
                            data: {
                                refundedAmount: { increment: reversalAmount },
                                ...(fullyRefunded
                                    ? { status: terminalPaymentStatus, failedAt: new Date() }
                                    : {}),
                            },
                        });
                    }
                }
                else if (wallet) {
                    this.logger.error(`Reversal for order ${midtransOrderId}: availableBalance (${wallet.availableBalance}) < refund amount (${reversalAmount}); locking wallet for manual reconciliation`);
                    await tx.wallet.update({
                        where: { id: wallet.id },
                        data: {
                            isLocked: true,
                            lockReason: `Auto-locked: post-settlement reversal insufficient balance — could not debit ${reversalAmount} (order: ${midtransOrderId}). Manual reconciliation required.`,
                            lockedAt: new Date(),
                            lockedBy: 'SYSTEM',
                        },
                    });
                    await tx.walletTransaction.updateMany({
                        where: {
                            paymentTxId: paymentTx.id,
                            type: client_1.WalletTransactionType.TOP_UP,
                            status: client_1.WalletTransactionStatus.SUCCESS,
                        },
                        data: {
                            failureReason: `Post-settlement reversal requires manual recovery: insufficient balance for ${midtransOrderId}`,
                            description: `Post-settlement reversal pending manual recovery (order: ${midtransOrderId}). Wallet locked.`,
                        },
                    });
                    await tx.paymentTransaction.update({
                        where: { id: currentPaymentTx.id },
                        data: {
                            refundedAmount: { increment: reversalAmount },
                            ...(fullyRefunded
                                ? { status: terminalPaymentStatus, failedAt: new Date() }
                                : {}),
                        },
                    });
                    await tx.notification.create({
                        data: {
                            notifId: (0, id_generator_util_1.generateNotifId)(),
                            userId: paymentTx.userId,
                            type: client_1.NotificationType.SECURITY_ACCOUNT_LOCKED,
                            category: (0, notification_category_map_1.getCategoryForType)(client_1.NotificationType.SECURITY_ACCOUNT_LOCKED),
                            title: 'Wallet Locked',
                            body: 'Your wallet has been automatically locked due to a technical issue with your payment. Please contact customer support for assistance.',
                            isRead: false,
                        },
                    });
                }
                else {
                    await tx.walletTransaction.updateMany({
                        where: {
                            paymentTxId: paymentTx.id,
                            type: client_1.WalletTransactionType.TOP_UP,
                            status: client_1.WalletTransactionStatus.SUCCESS,
                        },
                        data: { status: client_1.WalletTransactionStatus.FAILED },
                    });
                    await tx.paymentTransaction.update({
                        where: { id: currentPaymentTx.id },
                        data: {
                            refundedAmount: { increment: reversalAmount },
                            ...(fullyRefunded
                                ? { status: terminalPaymentStatus, failedAt: new Date() }
                                : {}),
                        },
                    });
                }
            }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable }), 'TOPUP_REVERSAL');
            this.runRealtimeBestEffort(() => this.realtime.emitToUser(paymentTx.userId, 'wallet.balance_updated', {
                userId: paymentTx.userId,
            }), 'TOPUP_REVERSAL_BALANCE');
        }
    }
    async confirmWithdrawOtp(userId, txId, otpCode) {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user)
            throw new common_1.NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'User not found' });
        if (!user.email) {
            throw new common_1.BadRequestException({
                code: 'EMAIL_NOT_CONFIGURED',
                message: 'Add an email address before confirming a withdrawal.',
            });
        }
        const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
        if (!wallet)
            throw new common_1.NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Wallet not found' });
        if (wallet.isLocked) {
            throw new common_1.ForbiddenException({
                code: ErrorCodes.WALLET_LOCKED,
                message: 'Wallet is locked. Withdrawal cannot be confirmed.',
            });
        }
        const lifecycleLockKey = (0, redis_keys_1.WALLET_LOCK)(userId);
        const lifecycleLockToken = `confirm-withdraw:${Date.now()}:${(0, crypto_1.randomBytes)(16).toString('hex')}`;
        const lifecycleLockAcquired = await this.redis.setNx(lifecycleLockKey, lifecycleLockToken, WITHDRAW_LIFECYCLE_LOCK_TTL_SECONDS);
        if (!lifecycleLockAcquired) {
            throw new common_1.ConflictException({
                code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                message: 'Another withdrawal operation is in progress. Please try again.',
            });
        }
        try {
            const walletTx = await this.prisma.walletTransaction.findFirst({
                where: {
                    txId,
                    walletId: wallet.id,
                    type: client_1.WalletTransactionType.WITHDRAW,
                    status: client_1.WalletTransactionStatus.PENDING,
                    withdrawStatus: client_1.WithdrawStatus.PENDING_OTP,
                },
                include: { bankAccount: true },
            });
            if (!walletTx) {
                const alreadyClaimed = await this.prisma.walletTransaction.findFirst({
                    where: { txId, walletId: wallet.id },
                    select: { txId: true, amount: true, withdrawStatus: true },
                });
                if (alreadyClaimed?.withdrawStatus === client_1.WithdrawStatus.PENDING_PROCESS) {
                    return {
                        txId,
                        status: client_1.WithdrawStatus.PENDING_PROCESS,
                        message: 'Withdrawal is already awaiting admin approval',
                    };
                }
                throw new common_1.NotFoundException({
                    code: ErrorCodes.NOT_FOUND,
                    message: 'Withdrawal transaction not found or already processed',
                });
            }
            const otpResult = await this.otpService.verifyOtpWithMetadata(user.email ?? '', client_2.OtpType.WITHDRAW_CONFIRMATION, otpCode, { consume: false });
            if (!otpResult.valid) {
                throw new common_1.UnauthorizedException({
                    code: ErrorCodes.OTP_INVALID,
                    message: 'Invalid or expired OTP',
                });
            }
            if (!otpResult.metadata?.walletTxId || otpResult.metadata.walletTxId !== txId) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.OTP_TX_MISMATCH,
                    message: 'This OTP was issued for a different withdrawal',
                });
            }
            if (!otpResult.metadata.bankAccountId ||
                otpResult.metadata.bankAccountId !== walletTx.bankAccountId) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.OTP_TX_MISMATCH,
                    message: 'This OTP was issued for a different bank account',
                });
            }
            if (otpResult.metadata.amountSen == null ||
                BigInt(otpResult.metadata.amountSen) !== walletTx.amount) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.OTP_TX_MISMATCH,
                    message: 'This OTP was issued for a different withdrawal amount',
                });
            }
            const OTP_MAX_AGE_MS = (this.configService.get('app.otpExpiresMinutes') ?? app_constants_1.OTP_EXPIRES_MINUTES) *
                60 *
                1000;
            if (otpResult.metadata.timestamp == null) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.OTP_INVALID,
                    message: 'OTP is missing its expiry metadata. Please request a new one.',
                });
            }
            const otpAge = Date.now() - otpResult.metadata.timestamp;
            if (otpAge > OTP_MAX_AGE_MS || otpAge < 0) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.OTP_INVALID,
                    message: 'OTP has expired. Please request a new one.',
                });
            }
            let result;
            let confirmLastError;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    result = await this.prisma.$transaction(async (tx) => {
                        await tx.$queryRaw `SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
                        const lockedWallet = await tx.wallet.findUnique({ where: { id: wallet.id } });
                        if (!lockedWallet)
                            throw new common_1.NotFoundException({
                                code: ErrorCodes.NOT_FOUND,
                                message: 'Wallet not found',
                            });
                        if (lockedWallet.isLocked) {
                            throw new common_1.ForbiddenException({
                                code: ErrorCodes.WALLET_LOCKED,
                                message: 'Wallet is locked. Withdrawal cannot be confirmed.',
                            });
                        }
                        const claimed = await tx.walletTransaction.updateMany({
                            where: {
                                id: walletTx.id,
                                type: client_1.WalletTransactionType.WITHDRAW,
                                status: client_1.WalletTransactionStatus.PENDING,
                                withdrawStatus: client_1.WithdrawStatus.PENDING_OTP,
                            },
                            data: {
                                withdrawStatus: client_1.WithdrawStatus.PENDING_PROCESS,
                                status: client_1.WalletTransactionStatus.PENDING,
                            },
                        });
                        if (claimed.count === 0) {
                            throw new common_1.ConflictException({
                                code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                                message: 'Withdrawal already being processed',
                            });
                        }
                        return { txId, amount: walletTx.amount };
                    }, {
                        isolationLevel: client_1.Prisma.TransactionIsolationLevel.RepeatableRead,
                        maxWait: 10000,
                        timeout: 15000,
                    });
                    confirmLastError = null;
                    break;
                }
                catch (err) {
                    confirmLastError = err;
                    if (!this.isRetryableDbError(err) || attempt === 3) {
                        this.logger.error(`CONFIRM_WITHDRAW_TX_FAILED wallet=${wallet.id} txId=${txId} attempt=${attempt}/3`, err instanceof Error ? err.stack : String(err));
                        break;
                    }
                    this.logger.warn(`CONFIRM_WITHDRAW_TX_RETRY wallet=${wallet.id} txId=${txId} attempt=${attempt}/3`);
                    await new Promise(resolve => setTimeout(resolve, 100 * attempt));
                }
            }
            if (confirmLastError)
                throw confirmLastError;
            if (otpResult.otpId) {
                const consumed = await this.otpService.consumeVerifiedOtp(otpResult.otpId);
                if (!consumed)
                    this.logger.warn(`Withdrawal OTP could not be consumed after claim: txId=${txId} otpId=${otpResult.otpId}`);
            }
            this.runRealtimeBestEffort(() => this.realtime.emitToUser(userId, 'wallet.balance_updated', { userId }), 'CONFIRM_WITHDRAW_BALANCE');
            this.logger.log(`Withdrawal queued for admin approval: txId=${txId} userId=${userId} amount=${result.amount}`);
            return {
                txId,
                status: 'PENDING_PROCESS',
                message: 'Withdrawal request submitted and awaiting admin approval',
            };
        }
        finally {
            await this.redis
                .releaseLock(lifecycleLockKey, lifecycleLockToken)
                .catch(err => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
        }
    }
    async resendWithdrawOtp(userId, txId, ipAddress) {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user)
            throw new common_1.NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'User not found' });
        if (!user.email) {
            throw new common_1.BadRequestException({
                code: 'EMAIL_NOT_CONFIGURED',
                message: 'Add an email address before requesting a new withdrawal confirmation code.',
            });
        }
        const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
        if (!wallet)
            throw new common_1.NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Wallet not found' });
        if (wallet.isLocked) {
            throw new common_1.ForbiddenException({
                code: ErrorCodes.WALLET_LOCKED,
                message: 'Wallet is locked. Withdrawal OTP cannot be resent.',
            });
        }
        const lifecycleLockKey = (0, redis_keys_1.WALLET_LOCK)(userId);
        const lifecycleLockToken = `resend-withdraw:${Date.now()}:${(0, crypto_1.randomBytes)(16).toString('hex')}`;
        const lifecycleLockAcquired = await this.redis.setNx(lifecycleLockKey, lifecycleLockToken, WITHDRAW_LIFECYCLE_LOCK_TTL_SECONDS);
        if (!lifecycleLockAcquired) {
            throw new common_1.ConflictException({
                code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                message: 'Another withdrawal operation is in progress. Please try again.',
            });
        }
        try {
            const walletTx = await this.prisma.walletTransaction.findFirst({
                where: {
                    txId,
                    walletId: wallet.id,
                    type: client_1.WalletTransactionType.WITHDRAW,
                    status: client_1.WalletTransactionStatus.PENDING,
                    withdrawStatus: client_1.WithdrawStatus.PENDING_OTP,
                },
            });
            if (!walletTx) {
                throw new common_1.NotFoundException({
                    code: ErrorCodes.NOT_FOUND,
                    message: 'No pending withdrawal found with this ID',
                });
            }
            const cooldownKey = (0, redis_keys_1.WITHDRAW_OTP_COOLDOWN)(userId);
            const acquired = await this.redis.setNx(cooldownKey, '1', 60);
            if (!acquired) {
                const ttl = await this.redis.ttl(cooldownKey);
                throw new common_1.BadRequestException({
                    code: 'OTP_COOLDOWN',
                    message: `Please wait ${ttl > 0 ? ttl : 60} seconds before requesting a new OTP.`,
                });
            }
            try {
                await this.otpService.invalidateOtps(user.email ?? '', client_2.OtpType.WITHDRAW_CONFIRMATION);
                const otp = await this.otpService.generateOtp(user.email ?? '', client_2.OtpType.WITHDRAW_CONFIRMATION, userId, {
                    walletTxId: txId,
                    amountSen: walletTx.amount.toString(),
                    bankAccountId: walletTx.bankAccountId,
                    timestamp: Date.now(),
                }, ipAddress);
                await this.emailQueue.add('send', {
                    to: user.email ?? '',
                    subject: 'Kahade - Withdrawal Confirmation Code',
                    templateName: 'withdrawal-otp',
                    templateContext: { otp },
                }, {
                    attempts: 3,
                    backoff: { type: 'exponential', delay: 5000 },
                    removeOnComplete: true,
                    removeOnFail: 50,
                });
                const refreshed = await this.prisma.walletTransaction.updateMany({
                    where: {
                        id: walletTx.id,
                        type: client_1.WalletTransactionType.WITHDRAW,
                        status: client_1.WalletTransactionStatus.PENDING,
                        withdrawStatus: client_1.WithdrawStatus.PENDING_OTP,
                    },
                    data: { updatedAt: new Date() },
                });
                if (refreshed.count === 0) {
                    throw new common_1.ConflictException({
                        code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                        message: 'Withdrawal was already confirmed or cancelled. Please refresh.',
                    });
                }
                return {
                    message: 'OTP resent successfully',
                    otpExpiredAt: new Date(Date.now() +
                        (this.configService.get('app.otpExpiresMinutes') ?? app_constants_1.OTP_EXPIRES_MINUTES) *
                            60 *
                            1000),
                };
            }
            catch (err) {
                await this.redis
                    .del(cooldownKey)
                    .catch((cleanupError) => this.logger.warn(`OTP cooldown rollback failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`));
                throw err;
            }
        }
        finally {
            await this.redis
                .releaseLock(lifecycleLockKey, lifecycleLockToken)
                .catch(err => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
        }
    }
    validatePinPolicy(pin) {
        if (pin.length !== 6 || !/^\d{6}$/.test(pin)) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.VALIDATION_ERROR,
                message: 'PIN must be exactly 6 digits',
            });
        }
        if (/^(\d)\1{5}$/.test(pin)) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.VALIDATION_ERROR,
                message: 'PIN must not be all repeated digits',
            });
        }
        const WEAK_SEQUENCES = [
            '012345',
            '123456',
            '234567',
            '345678',
            '456789',
            '567890',
            '098765',
            '987654',
            '876543',
            '765432',
            '654321',
            '543210',
        ];
        if (WEAK_SEQUENCES.includes(pin)) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.VALIDATION_ERROR,
                message: 'PIN must not be a sequential number',
            });
        }
        if (/^(\d)(\d)\1\2\1\2$/.test(pin)) {
            const [a, b] = pin;
            if (a !== b) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.VALIDATION_ERROR,
                    message: 'PIN must not be a repeating two-digit pattern',
                });
            }
        }
        if (/^(\d)\1(\d)\2(\d)\3$/.test(pin)) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.VALIDATION_ERROR,
                message: 'PIN must not consist of paired digits',
            });
        }
    }
    async setPin(userId, pin, currentPin, password, ip) {
        this.validatePinPolicy(pin);
        const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
        if (!wallet)
            throw new common_1.NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Wallet not found' });
        const hasExistingPin = wallet.walletPinHash !== null && wallet.walletPinHash !== '';
        if (!password) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.FORBIDDEN,
                message: 'Account password is required to set or change wallet PIN',
            });
        }
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { password: true },
        });
        if (!user?.password) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.NOT_FOUND,
                message: 'User account not found',
            });
        }
        const passwordValid = await (0, crypto_util_1.bcryptCompare)(password, user.password);
        if (!passwordValid) {
            throw new common_1.UnauthorizedException({
                code: ErrorCodes.UNAUTHORIZED,
                message: 'Account password is incorrect',
            });
        }
        if (hasExistingPin) {
            if (!currentPin) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.FORBIDDEN,
                    message: 'Current PIN is required to change an existing PIN',
                });
            }
            await this.verifyWalletPin(wallet, currentPin, userId, ip);
        }
        const pinDigest = (0, crypto_util_1.hmacPinDigest)(this.walletPinPepper, pin);
        const hashedPin = await (0, crypto_util_1.bcryptHash)(pinDigest, (0, crypto_util_1.getBcryptRounds)());
        await this.prisma.wallet.update({
            where: { userId },
            data: { walletPinHash: hashedPin },
        });
        return {
            message: hasExistingPin
                ? 'Wallet PIN has been changed successfully'
                : 'Wallet PIN has been set successfully',
        };
    }
    async verifyPin(userId, pin, ip) {
        const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
        if (!wallet)
            throw new common_1.NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Wallet not found' });
        await this.verifyWalletPin(wallet, pin, userId, ip);
        return { valid: true };
    }
    getPaymentMethods() {
        const now = Date.now();
        if (this.paymentMethodsCache &&
            now - this.paymentMethodsCache.ts < this.PAYMENT_METHODS_CACHE_TTL) {
            return this.paymentMethodsCache.data;
        }
        const feeQris = this.configService.get('app.paymentFeeQrisPercent') ?? 0.7;
        const result = {
            methods: [
                {
                    id: 'QRIS',
                    nameKey: 'payment.qris',
                    name: 'QRIS',
                    category: 'qris',
                    enabled: true,
                    minAmount: 10000,
                    maxAmount: 10000000,
                    feeType: 'percent',
                    fee: feeQris,
                },
            ],
        };
        this.paymentMethodsCache = { data: result, ts: now };
        return result;
    }
    async getHeldEscrowReleaseAmount(tx, walletId) {
        const holdCutoff = new Date(Date.now() - app_constants_1.ESCROW_RELEASE_HOLD_HOURS * 60 * 60 * 1000);
        const wallet = await tx.wallet.findUnique({
            where: { id: walletId },
            select: { userId: true },
        });
        if (!wallet)
            return BigInt(0);
        const recentCompletedOrders = await tx.order.findMany({
            where: {
                sellerId: wallet.userId,
                status: 'COMPLETED',
                completedAt: { gt: holdCutoff },
            },
            select: { sellerReceiveAmount: true },
        });
        return recentCompletedOrders.reduce((sum, o) => sum + o.sellerReceiveAmount, BigInt(0));
    }
    runRealtimeBestEffort(task, label) {
        try {
            task();
        }
        catch (error) {
            this.logger.warn(`${label} realtime side effect failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async withWalletSerializableRetry(operation, label) {
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                return await operation();
            }
            catch (error) {
                if (!this.isRetryableDbError(error) || attempt === 3)
                    throw error;
                this.logger.warn(`${label}_RETRY attempt=${attempt}/3`);
                await new Promise(resolve => setTimeout(resolve, 100 * attempt + (0, crypto_1.randomInt)(0, 50)));
            }
        }
        throw new Error(`${label} exhausted retry loop`);
    }
    isRetryableDbError(err) {
        if (err instanceof client_1.Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
            return true;
        }
        if (err instanceof client_1.Prisma.PrismaClientUnknownRequestError) {
            const msg = err.message.toLowerCase();
            if (msg.includes('40001') ||
                msg.includes('serialization') ||
                msg.includes('40p01') ||
                msg.includes('deadlock')) {
                return true;
            }
        }
        return false;
    }
    async getNextWalletTxSerial() {
        return this.walletTxSerialService.getNext();
    }
    async getNextPaymentSerial() {
        return this.walletTxSerialService.getNextForPrefix('payment_serial');
    }
};
exports.WalletService = WalletService;
exports.WalletService = WalletService = WalletService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(8, (0, bull_1.InjectQueue)(email_processor_1.EMAIL_QUEUE)),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService,
        config_1.ConfigService,
        wallet_tx_serial_service_1.WalletTxSerialService,
        audit_log_service_1.AuditLogService,
        midtrans_service_1.MidtransService,
        otp_service_1.OtpService,
        realtime_service_1.RealtimeService, Object])
], WalletService);
