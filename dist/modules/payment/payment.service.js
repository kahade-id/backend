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
var PaymentService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.PaymentService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const crypto_1 = require("crypto");
const wallet_service_1 = require("../wallet/wallet.service");
const prisma_service_1 = require("../../prisma/prisma.service");
const redis_service_1 = require("../../redis/redis.service");
const redis_keys_1 = require("../../common/constants/redis-keys");
const order_qris_payment_service_1 = require("./order-qris-payment.service");
const webhook_retry_constants_1 = require("./webhook-retry.constants");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const WEBHOOK_PROCESSING_TTL_SECONDS = 5 * 60;
const WEBHOOK_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
let PaymentService = PaymentService_1 = class PaymentService {
    constructor(configService, walletService, orderQrisPaymentService, prismaService, redisService) {
        this.configService = configService;
        this.walletService = walletService;
        this.orderQrisPaymentService = orderQrisPaymentService;
        this.prismaService = prismaService;
        this.redisService = redisService;
        this.logger = new common_1.Logger(PaymentService_1.name);
    }
    async handleMidtransWebhook(notification, sourceIp) {
        if (!this.isValidMidtransSourceIp(sourceIp)) {
            this.logger.warn(`Midtrans webhook rejected: unauthorized source IP ${sourceIp}`);
            throw new common_1.ForbiddenException({
                code: ErrorCodes.WEBHOOK_UNAUTHORIZED_IP,
                message: 'Unauthorized webhook source',
            });
        }
        const order_id = notification.order_id;
        const status_code = notification.status_code;
        const gross_amount = notification.gross_amount;
        const signature_key = notification.signature_key;
        const transaction_status = notification.transaction_status;
        const transaction_id = notification.transaction_id;
        if (!order_id || !status_code || !gross_amount || !signature_key) {
            throw new common_1.BadRequestException({
                code: 'WEBHOOK_MISSING_FIELDS',
                message: 'Required webhook fields missing',
            });
        }
        const VALID_MIDTRANS_STATUSES = [
            'pending',
            'capture',
            'settlement',
            'deny',
            'authorize',
            'expire',
            'cancel',
            'refund',
            'partial_refund',
            'chargeback',
            'partial_chargeback',
            'failure',
        ];
        if (!transaction_status ||
            !VALID_MIDTRANS_STATUSES.includes(transaction_status)) {
            this.logger.warn(`Midtrans webhook unknown transaction_status="${transaction_status}" for order=${order_id}`);
            throw new common_1.BadRequestException({
                code: 'WEBHOOK_INVALID_STATUS',
                message: 'Invalid transaction status',
            });
        }
        if (!this.verifyMidtransSignature(order_id, status_code, gross_amount, signature_key)) {
            this.logger.warn(`Midtrans webhook signature mismatch for order: ${order_id}`);
            throw new common_1.ForbiddenException({
                code: 'WEBHOOK_SIGNATURE_INVALID',
                message: 'Invalid webhook signature',
            });
        }
        if (!transaction_id) {
            this.logger.warn(`Midtrans webhook missing transaction_id for order=${order_id}`);
            throw new common_1.BadRequestException({
                code: 'WEBHOOK_MISSING_FIELDS',
                message: 'Required webhook field transaction_id missing',
            });
        }
        const requiresRefundKey = transaction_status === 'refund' || transaction_status === 'partial_refund';
        const isPartialReversal = transaction_status === 'partial_refund' || transaction_status === 'partial_chargeback';
        const refundReference = requiresRefundKey ? notification.refund_key?.trim() : undefined;
        if (requiresRefundKey && !refundReference) {
            throw new common_1.BadRequestException({
                code: 'WEBHOOK_REFUND_REFERENCE_REQUIRED',
                message: 'refund_key is required for refund notifications',
            });
        }
        if (isPartialReversal && !notification.refund_amount) {
            throw new common_1.BadRequestException({
                code: 'WEBHOOK_REVERSAL_AMOUNT_REQUIRED',
                message: 'refund_amount is required for partial reversal notifications',
            });
        }
        const eventDiscriminator = refundReference
            ? `${transaction_status}:${refundReference}`
            : isPartialReversal
                ? `${transaction_status}:${notification.refund_amount}`
                : transaction_status;
        const processedKey = (0, redis_keys_1.WEBHOOK_PROCESSED)(transaction_id, eventDiscriminator);
        const processingKey = (0, redis_keys_1.WEBHOOK_PROCESSING)(transaction_id, eventDiscriminator);
        const processingToken = (0, crypto_1.randomUUID)();
        const eventKey = `MIDTRANS:${transaction_id}:${eventDiscriminator}`;
        const webhookLog = await this.prismaService.webhookLog.upsert({
            where: { eventKey },
            create: {
                source: 'MIDTRANS',
                event: transaction_status,
                payload: notification,
                transactionId: transaction_id,
                eventKey,
                isProcessed: false,
                ipAddress: sourceIp,
                lastAttemptAt: new Date(),
            },
            update: {
                ipAddress: sourceIp,
                lastAttemptAt: new Date(),
            },
        });
        if (webhookLog.isProcessed) {
            this.logger.warn(`Midtrans webhook duplicate — durable inbox already processed: txn=${transaction_id}`);
            return { message: 'OK' };
        }
        const paymentTransaction = await this.prismaService.paymentTransaction.findFirst({
            where: { midtransOrderId: order_id },
            select: { id: true, userId: true, orderId: true, status: true, purpose: true },
        });
        if (!paymentTransaction) {
            await this.prismaService.webhookLog.update({
                where: { id: webhookLog.id },
                data: {
                    isProcessed: true,
                    processedAt: new Date(),
                    errorMessage: 'UNKNOWN_PAYMENT_TRANSACTION: manual review required',
                },
            });
            this.logger.error(`Midtrans webhook quarantined: no payment transaction for order=${order_id}`);
            return { message: 'OK' };
        }
        if (paymentTransaction.purpose !== 'TOPUP' && paymentTransaction.purpose !== 'ORDER_ESCROW') {
            await this.prismaService.webhookLog.update({
                where: { id: webhookLog.id },
                data: {
                    isProcessed: true,
                    processedAt: new Date(),
                    errorMessage: `UNKNOWN_PAYMENT_PURPOSE: ${String(paymentTransaction.purpose)}; manual review required`,
                },
            });
            this.logger.error(`Midtrans webhook quarantined: unsupported payment purpose for order=${order_id}`);
            return { message: 'OK' };
        }
        if (webhookLog.deadLetteredAt) {
            this.logger.error(`Midtrans webhook is dead-lettered and requires manual review: txn=${transaction_id}`);
            throw new common_1.ServiceUnavailableException({
                code: 'WEBHOOK_DEAD_LETTERED',
                message: 'Webhook requires manual review before retry.',
            });
        }
        const claimedProcessing = await this.redisService.setNx(processingKey, processingToken, WEBHOOK_PROCESSING_TTL_SECONDS);
        if (!claimedProcessing) {
            this.logger.warn(`Midtrans webhook concurrent delivery — returning 503 for retry: txn=${transaction_id}`);
            throw new common_1.ServiceUnavailableException({
                code: 'WEBHOOK_CONCURRENT',
                message: 'Webhook is being processed by another handler. Retry later.',
            });
        }
        this.logger.log(`Midtrans webhook received: order=${order_id} txn=${transaction_id} status=${transaction_status}`);
        const TERMINAL_FAILURE_STATUSES = [
            'deny',
            'expire',
            'cancel',
            'failure',
            'refund',
            'partial_refund',
            'chargeback',
            'partial_chargeback',
        ];
        try {
            if (transaction_status === 'settlement') {
                if (paymentTransaction.purpose === 'ORDER_ESCROW') {
                    await this.orderQrisPaymentService.handleSettlement(order_id, gross_amount);
                    this.logger.log(`QRIS escrow locked for order payment: ${order_id}`);
                }
                else {
                    await this.walletService.handleTopupSuccess(order_id, gross_amount);
                    this.logger.log(`Topup credited for order: ${order_id}`);
                }
            }
            else if (transaction_status === 'capture') {
                const fraudStatus = notification.fraud_status;
                if (fraudStatus === 'accept') {
                    if (paymentTransaction.purpose === 'ORDER_ESCROW') {
                        await this.orderQrisPaymentService.handleSettlement(order_id, gross_amount);
                        this.logger.log(`QRIS escrow locked (capture+accept) for order payment: ${order_id}`);
                    }
                    else {
                        await this.walletService.handleTopupSuccess(order_id, gross_amount);
                        this.logger.log(`Topup credited (capture+accept) for order: ${order_id}`);
                    }
                }
                else if (fraudStatus === 'deny') {
                    if (paymentTransaction.purpose === 'ORDER_ESCROW') {
                        await this.orderQrisPaymentService.handleFailure(order_id, 'DENY');
                        this.logger.log(`QRIS order payment denied (capture+deny): ${order_id}`);
                    }
                    else {
                        await this.walletService.handleTopupFailure(order_id, 'DENY');
                        this.logger.log(`Topup denied (capture+deny) for order: ${order_id}`);
                    }
                }
                else if (fraudStatus === 'challenge') {
                    this.logger.error(`SECURITY: Capture with fraud_status=challenge for order: ${order_id} — funds NOT credited, flagging for admin review`);
                    await this.prismaService.paymentTransaction.updateMany({
                        where: { midtransOrderId: order_id, status: 'PENDING' },
                        data: { fraudStatus: 'challenge', webhookReceivedAt: new Date() },
                    });
                    await this.prismaService.webhookLog.update({
                        where: { id: webhookLog.id },
                        data: {
                            isProcessed: true,
                            processedAt: new Date(),
                            errorMessage: 'FRAUD_CHALLENGE: requires manual review — funds held',
                        },
                    });
                    await this.redisService
                        .setex(processedKey, WEBHOOK_IDEMPOTENCY_TTL_SECONDS, new Date().toISOString(), {
                        throwOnError: true,
                    })
                        .catch((e) => this.logger.warn(`Redis processed cache failed: ${e.message}`));
                    await this.redisService
                        .releaseLock(processingKey, processingToken)
                        .catch((e) => this.logger.warn(`Redis release processingKey failed: ${e.message}`));
                    return { message: 'OK' };
                }
                else {
                    this.logger.error(`SECURITY: Capture with unknown fraud_status="${fraudStatus}" for order: ${order_id} — flagging for manual review`);
                    await this.prismaService.paymentTransaction.updateMany({
                        where: { midtransOrderId: order_id, status: 'PENDING' },
                        data: {
                            fraudStatus: `unknown:${String(fraudStatus).slice(0, 32)}`,
                            webhookReceivedAt: new Date(),
                        },
                    });
                    await this.prismaService.webhookLog.update({
                        where: { id: webhookLog.id },
                        data: {
                            isProcessed: true,
                            processedAt: new Date(),
                            errorMessage: `UNKNOWN_FRAUD_STATUS: fraud_status="${fraudStatus}" requires manual review`,
                        },
                    });
                    await this.redisService
                        .setex(processedKey, WEBHOOK_IDEMPOTENCY_TTL_SECONDS, new Date().toISOString(), {
                        throwOnError: true,
                    })
                        .catch((e) => this.logger.warn(`Redis processed cache failed: ${e.message}`));
                    await this.redisService
                        .releaseLock(processingKey, processingToken)
                        .catch((e) => this.logger.warn(`Redis release processingKey failed: ${e.message}`));
                    return { message: 'OK' };
                }
            }
            else if (transaction_status &&
                TERMINAL_FAILURE_STATUSES.includes(transaction_status)) {
                if (paymentTransaction.purpose === 'ORDER_ESCROW') {
                    if (transaction_status === 'refund' || transaction_status === 'chargeback') {
                        await this.orderQrisPaymentService.handleRefund(order_id, refundReference ?? transaction_status);
                    }
                    else if (transaction_status === 'partial_refund' ||
                        transaction_status === 'partial_chargeback') {
                        throw new common_1.ServiceUnavailableException({
                            code: 'ORDER_QRIS_PARTIAL_REVERSAL_REQUIRES_REVIEW',
                            message: 'Partial QRIS reversal requires manual review before escrow can be adjusted.',
                        });
                    }
                    else {
                        await this.orderQrisPaymentService.handleFailure(order_id, transaction_status);
                    }
                    this.logger.log(`QRIS order payment terminal status handled: ${order_id} (${transaction_status})`);
                }
                else {
                    await this.walletService.handleTopupFailure(order_id, transaction_status.toUpperCase(), requiresRefundKey || isPartialReversal
                        ? { refundAmount: notification.refund_amount, refundReference }
                        : undefined);
                    this.logger.log(`Topup marked FAILED for order: ${order_id} (status: ${transaction_status})`);
                }
            }
            else {
                this.logger.log(`Non-terminal notification status=${transaction_status} for order: ${order_id} — marking inbox event processed`);
            }
        }
        catch (err) {
            const attempt = webhookLog.retryCount + 1;
            const deadLettered = attempt >= webhook_retry_constants_1.MAX_WEBHOOK_ATTEMPTS;
            await this.prismaService.webhookLog
                .update({
                where: { id: webhookLog.id },
                data: {
                    errorMessage: String(err.message ?? err).slice(0, 4000),
                    retryCount: attempt,
                    lastAttemptAt: new Date(),
                    nextRetryAt: deadLettered ? null : (0, webhook_retry_constants_1.getWebhookRetryAt)(attempt),
                    deadLetteredAt: deadLettered ? new Date() : null,
                },
            })
                .catch(updateError => this.logger.error(`Failed to persist webhook failure: ${updateError.message}`));
            await this.redisService
                .releaseLock(processingKey, processingToken)
                .catch((e) => this.logger.warn(`Redis release processingKey failed: ${e.message}`));
            throw err;
        }
        await this.prismaService.webhookLog
            .update({
            where: { id: webhookLog.id },
            data: {
                isProcessed: true,
                processedAt: new Date(),
                lastAttemptAt: new Date(),
                nextRetryAt: null,
                deadLetteredAt: null,
                errorMessage: null,
            },
        })
            .catch(err => {
            this.logger.error(`Failed to update WebhookLog: ${err.message}`);
            throw err;
        });
        await this.redisService
            .setex(processedKey, WEBHOOK_IDEMPOTENCY_TTL_SECONDS, new Date().toISOString(), {
            throwOnError: true,
        })
            .catch((e) => this.logger.warn(`Redis processed cache failed: ${e.message}`));
        await this.redisService
            .releaseLock(processingKey, processingToken)
            .catch((e) => this.logger.warn(`Redis release processingKey failed: ${e.message}`));
        return { message: 'OK' };
    }
    verifyMidtransSignature(orderId, statusCode, grossAmount, incomingSignatureKey) {
        const serverKey = this.configService.get('midtrans.serverKey');
        if (!serverKey) {
            this.logger.error('MIDTRANS_SERVER_KEY is not configured — cannot verify webhook signature');
            return false;
        }
        const payload = `${orderId}${statusCode}${grossAmount}${serverKey}`;
        const expectedSignature = (0, crypto_1.createHash)('sha512').update(payload).digest('hex');
        const expectedBuf = Buffer.from(expectedSignature, 'utf8');
        const incomingBuf = Buffer.from(incomingSignatureKey ?? '', 'utf8');
        if (expectedBuf.length !== incomingBuf.length) {
            return false;
        }
        try {
            return (0, crypto_1.timingSafeEqual)(expectedBuf, incomingBuf);
        }
        catch {
            return false;
        }
    }
    isValidMidtransSourceIp(ip) {
        const bypassIpCheck = this.configService.get('midtrans.bypassIpCheck') === true;
        if (bypassIpCheck) {
            const nodeEnv = (this.configService.get('app.nodeEnv') || 'development')
                .trim()
                .toLowerCase();
            if (nodeEnv === 'production' || nodeEnv === 'prod' || nodeEnv === 'staging') {
                this.logger.error(`MIDTRANS_BYPASS_IP_CHECK=true is forbidden in ${nodeEnv} — ignoring bypass flag`);
            }
            else {
                this.logger.warn(`Midtrans IP allowlist bypassed via MIDTRANS_BYPASS_IP_CHECK (source: ${ip})`);
                return true;
            }
        }
        const cidrsRaw = this.configService.get('midtrans.allowedCidrs') || '';
        if (!cidrsRaw) {
            this.logger.error('MIDTRANS_ALLOWED_CIDRS is not configured — rejecting webhook');
            return false;
        }
        let normalizedIp = ip;
        const ipv4MappedMatch = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
        if (ipv4MappedMatch) {
            normalizedIp = ipv4MappedMatch[1];
        }
        const isIPv6 = normalizedIp.includes(':');
        if (isIPv6) {
            const allowedList = cidrsRaw
                .split(',')
                .map(c => c.trim())
                .filter(Boolean);
            return allowedList.some(cidr => {
                const [cidrAddr, cidrPrefix] = cidr.split('/');
                const prefixLen = parseInt(cidrPrefix ?? '128', 10);
                if (isNaN(prefixLen) || prefixLen < 0 || prefixLen > 128)
                    return false;
                const expandedIp = this.expandIPv6(normalizedIp);
                const expandedCidr = this.expandIPv6(cidrAddr.trim());
                if (!expandedIp || !expandedCidr)
                    return false;
                const ipBits = this.ipv6ToBits(expandedIp);
                const cidrBits = this.ipv6ToBits(expandedCidr);
                return ipBits.substring(0, prefixLen) === cidrBits.substring(0, prefixLen);
            });
        }
        const allowedCidrs = cidrsRaw
            .split(',')
            .map(c => c.trim())
            .filter(Boolean)
            .map(cidr => {
            const [networkStr, prefixStr] = cidr.split('/');
            const network = networkStr.split('.').map(Number);
            const prefixLen = parseInt(prefixStr ?? '32', 10);
            return { network, prefixLen };
        })
            .filter(({ network, prefixLen }) => {
            if (!Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > 32)
                return false;
            if (network.length !== 4)
                return false;
            return network.every(p => Number.isInteger(p) && p >= 0 && p <= 255);
        });
        const parts = normalizedIp.split('.').map(Number);
        if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255))
            return false;
        return allowedCidrs.some(({ network, prefixLen }) => {
            const ipInt = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
            const netInt = (network[0] << 24) | (network[1] << 16) | (network[2] << 8) | network[3];
            const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
            return ((ipInt >>> 0) & mask) === ((netInt >>> 0) & mask);
        });
    }
    expandIPv6(ip) {
        try {
            let groups;
            if (ip.includes('::')) {
                const [left, right] = ip.split('::');
                const leftGroups = left ? left.split(':') : [];
                const rightGroups = right ? right.split(':') : [];
                const missing = 8 - leftGroups.length - rightGroups.length;
                if (missing < 0)
                    return null;
                groups = [...leftGroups, ...Array(missing).fill('0'), ...rightGroups];
            }
            else {
                groups = ip.split(':');
            }
            if (groups.length !== 8)
                return null;
            return groups.map(g => g.padStart(4, '0')).join(':');
        }
        catch {
            return null;
        }
    }
    ipv6ToBits(expandedIp) {
        return expandedIp
            .replace(/:/g, '')
            .split('')
            .map(hex => parseInt(hex, 16).toString(2).padStart(4, '0'))
            .join('');
    }
};
exports.PaymentService = PaymentService;
exports.PaymentService = PaymentService = PaymentService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService,
        wallet_service_1.WalletService,
        order_qris_payment_service_1.OrderQrisPaymentService,
        prisma_service_1.PrismaService,
        redis_service_1.RedisService])
], PaymentService);
