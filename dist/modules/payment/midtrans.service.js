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
var MidtransService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.MidtransService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const client_1 = require("@prisma/client");
const midtransClient = __importStar(require("midtrans-client"));
const circuit_breaker_1 = require("../../common/utils/circuit-breaker");
function isCircuitOpenError(error) {
    if (!error || typeof error !== 'object')
        return false;
    const response = error.response;
    if (!response || typeof response !== 'object')
        return false;
    return response.code === 'SERVICE_CIRCUIT_OPEN';
}
let MidtransService = MidtransService_1 = class MidtransService {
    constructor(configService) {
        this.configService = configService;
        this.logger = new common_1.Logger(MidtransService_1.name);
        this.circuitBreaker = new circuit_breaker_1.CircuitBreaker({
            name: 'MidtransCoreCircuitBreaker',
            failureThreshold: parseInt(process.env.MIDTRANS_CB_FAILURE_THRESHOLD || '5', 10),
            recoveryTimeMs: parseInt(process.env.MIDTRANS_CB_RECOVERY_MS || '30000', 10),
            halfOpenMaxAttempts: 1,
        });
        this.irisCircuitBreaker = new circuit_breaker_1.CircuitBreaker({
            name: 'MidtransIrisCircuitBreaker',
            failureThreshold: parseInt(process.env.MIDTRANS_IRIS_CB_FAILURE_THRESHOLD || '5', 10),
            recoveryTimeMs: parseInt(process.env.MIDTRANS_IRIS_CB_RECOVERY_MS || '30000', 10),
            halfOpenMaxAttempts: 1,
        });
    }
    async onModuleInit() {
        this.initializeClients();
    }
    initializeClients() {
        try {
            const serverKey = this.configService.get('midtrans.serverKey') ?? '';
            const isProduction = this.configService.get('midtrans.isProduction') ?? false;
            if (!serverKey) {
                throw new Error('MIDTRANS_SERVER_KEY is not configured');
            }
            this.coreApi = new midtransClient.CoreApi({
                isProduction,
                serverKey,
                clientKey: this.configService.get('midtrans.clientKey'),
            });
            this.logger.log(`MidtransService initialized [${isProduction ? 'PRODUCTION' : 'SANDBOX'}]`);
        }
        catch (err) {
            this.logger.error('Failed to initialize Midtrans client — service will operate in degraded mode. Payment operations will be unavailable until configuration is fixed.', err);
            this.coreApi = undefined;
        }
    }
    async chargeTransaction(params) {
        if (!this.coreApi) {
            throw new common_1.ServiceUnavailableException('Midtrans Core API client not initialized');
        }
        const parameter = this.buildChargeParameter(params);
        this.logger.log(`Core API charge: orderId=${params.orderId} method=${params.paymentMethod} amount=${params.grossAmount}`);
        try {
            const raw = await this.circuitBreaker.execute(() => this.coreApi.charge(parameter));
            return this.mapChargeResponse(raw, params.paymentMethod);
        }
        catch (error) {
            if (isCircuitOpenError(error)) {
                throw error;
            }
            this.logger.error(`Core API charge failed: orderId=${params.orderId}`, error instanceof Error ? error.stack : error);
            throw new common_1.ServiceUnavailableException({
                code: 'PAYMENT_CHARGE_FAILED',
                message: 'Payment processing failed. Please try again later.',
            });
        }
    }
    buildChargeParameter(params) {
        const { orderId, grossAmount, paymentMethod, userEmail, fullName } = params;
        const notificationUrl = this.configService.get('midtrans.notificationUrl');
        const expiryDuration = this.configService.get('app.topupExpiryHours') ?? 24;
        const base = {
            transaction_details: {
                order_id: orderId,
                gross_amount: grossAmount,
            },
            customer_details: {
                email: userEmail,
                first_name: fullName,
            },
            custom_expiry: {
                expiry_duration: expiryDuration * 60,
                unit: 'minute',
            },
        };
        if (notificationUrl) {
            base['notification_url'] = notificationUrl;
        }
        switch (paymentMethod) {
            case client_1.PaymentMethod.VIRTUAL_ACCOUNT_BCA:
                return { ...base, payment_type: 'bank_transfer', bank_transfer: { bank: 'bca' } };
            case client_1.PaymentMethod.VIRTUAL_ACCOUNT_BNI:
                return { ...base, payment_type: 'bank_transfer', bank_transfer: { bank: 'bni' } };
            case client_1.PaymentMethod.VIRTUAL_ACCOUNT_BRI:
                return { ...base, payment_type: 'bank_transfer', bank_transfer: { bank: 'bri' } };
            case client_1.PaymentMethod.VIRTUAL_ACCOUNT_CIMB:
                return { ...base, payment_type: 'bank_transfer', bank_transfer: { bank: 'cimb' } };
            case client_1.PaymentMethod.VIRTUAL_ACCOUNT_PERMATA:
                return { ...base, payment_type: 'bank_transfer', bank_transfer: { bank: 'permata' } };
            case client_1.PaymentMethod.VIRTUAL_ACCOUNT_MANDIRI:
                return {
                    ...base,
                    payment_type: 'echannel',
                    echannel: {
                        bill_info1: 'Payment:',
                        bill_info2: `Topup ${orderId}`,
                    },
                };
            case client_1.PaymentMethod.QRIS:
                return { ...base, payment_type: 'qris' };
            case client_1.PaymentMethod.GOPAY:
                return {
                    ...base,
                    payment_type: 'gopay',
                    gopay: {
                        enable_callback: true,
                        callback_url: this.configService.get('midtrans.callbackUrl') ?? 'https://kahade.id',
                    },
                };
            case client_1.PaymentMethod.SHOPEEPAY:
                return {
                    ...base,
                    payment_type: 'shopeepay',
                    shopeepay: {
                        callback_url: this.configService.get('midtrans.callbackUrl') ?? 'https://kahade.id',
                    },
                };
            case client_1.PaymentMethod.CREDIT_CARD:
                if (!params.cardToken) {
                    throw new common_1.BadRequestException({
                        code: 'CARD_TOKEN_REQUIRED',
                        message: 'Card token is required for credit card payment',
                    });
                }
                return {
                    ...base,
                    payment_type: 'credit_card',
                    credit_card: {
                        token_id: params.cardToken,
                        authentication: true,
                    },
                };
            case client_1.PaymentMethod.ALFAMART:
                return { ...base, payment_type: 'cstore', cstore: { store: 'alfamart' } };
            case client_1.PaymentMethod.INDOMARET:
                return { ...base, payment_type: 'cstore', cstore: { store: 'indomaret' } };
            case client_1.PaymentMethod.AKULAKU:
                return { ...base, payment_type: 'akulaku' };
            case client_1.PaymentMethod.KREDIVO:
                return {
                    ...base,
                    payment_type: 'kredivo',
                    kredivo: {
                        payment_type: '30_days',
                        items: [
                            {
                                id: orderId,
                                name: 'Wallet Top-up',
                                price: grossAmount,
                                quantity: 1,
                            },
                        ],
                    },
                };
            default:
                throw new common_1.BadRequestException('Unsupported payment method');
        }
    }
    mapChargeResponse(raw, method) {
        const result = {
            statusCode: String(raw['status_code'] ?? ''),
            transactionId: String(raw['transaction_id'] ?? ''),
            orderId: String(raw['order_id'] ?? ''),
            paymentType: String(raw['payment_type'] ?? ''),
            transactionStatus: String(raw['transaction_status'] ?? ''),
            grossAmount: String(raw['gross_amount'] ?? ''),
            expiryTime: raw['expiry_time'] ? String(raw['expiry_time']) : undefined,
        };
        const vaNumbers = raw['va_numbers'];
        if (vaNumbers && vaNumbers.length > 0) {
            result.vaNumber = vaNumbers[0].va_number;
            result.bankName = vaNumbers[0].bank;
        }
        if (raw['permata_va_number']) {
            result.vaNumber = String(raw['permata_va_number']);
            result.bankName = 'permata';
        }
        if (raw['bill_key']) {
            result.billKey = String(raw['bill_key']);
            result.billerCode = String(raw['biller_code'] ?? '');
        }
        const actions = raw['actions'];
        if (actions && actions.length > 0) {
            result.actions = actions;
            if (method === client_1.PaymentMethod.QRIS) {
                const generateQr = actions.find(a => a.name === 'generate-qr-code');
                if (generateQr) {
                    result.qrCodeUrl = generateQr.url;
                    result.qrString = generateQr.url;
                }
            }
        }
        if (raw['redirect_url']) {
            result.redirectUrl = String(raw['redirect_url']);
        }
        const paymentCode = raw['payment_code'];
        if (paymentCode) {
            result.paymentCode = paymentCode;
            result.store = raw['store'];
        }
        return result;
    }
    async getTransactionStatus(orderId) {
        if (!this.coreApi) {
            throw new common_1.ServiceUnavailableException('Midtrans Core API client not initialized');
        }
        try {
            return await this.circuitBreaker.execute(() => this.coreApi.transaction.status(orderId));
        }
        catch (error) {
            if (isCircuitOpenError(error)) {
                throw error;
            }
            this.logger.error(`Failed to get transaction status: orderId=${orderId}`, error instanceof Error ? error.stack : error);
            throw new common_1.ServiceUnavailableException({
                code: 'PAYMENT_STATUS_UNAVAILABLE',
                message: 'Unable to retrieve payment status. Please try again later.',
            });
        }
    }
    async cancelTransaction(orderId) {
        if (!this.coreApi) {
            throw new Error('Midtrans Core API client not initialized');
        }
        try {
            const result = await this.circuitBreaker.execute(() => this.coreApi.cancelTransaction(orderId));
            this.logger.log(`Transaction cancelled via Midtrans: orderId=${orderId}`);
            return result;
        }
        catch (error) {
            if (isCircuitOpenError(error)) {
                throw error;
            }
            this.logger.error(`Failed to cancel transaction: orderId=${orderId}`, error instanceof Error ? error.stack : error);
            throw error;
        }
    }
    async refundTransaction(orderId, amount, refundKey, reason) {
        if (!this.coreApi) {
            throw new Error('Midtrans Core API client not initialized');
        }
        try {
            const transactionApi = this.coreApi.transaction;
            const result = await this.circuitBreaker.execute(() => transactionApi.refund(orderId, {
                amount,
                refund_key: refundKey,
                reason,
            }));
            this.logger.log(`Transaction refund requested via Midtrans: orderId=${orderId}, refundKey=${refundKey}`);
            return result;
        }
        catch (error) {
            if (isCircuitOpenError(error)) {
                throw error;
            }
            this.logger.error(`Failed to request transaction refund: orderId=${orderId}`, error instanceof Error ? error.stack : error);
            throw error;
        }
    }
    getIrisBaseUrl() {
        return this.configService.get('midtrans.irisIsProduction')
            ? 'https://app.midtrans.com/iris'
            : 'https://app.sandbox.midtrans.com/iris';
    }
    getIrisAuthorization() {
        const irisKey = this.configService.get('midtrans.irisKey');
        if (!irisKey) {
            throw new Error('MIDTRANS_IRIS_KEY is not configured');
        }
        return Buffer.from(`${irisKey}:`).toString('base64');
    }
    async inquireBankAccount(bankCode, accountNumber) {
        return this.irisCircuitBreaker.execute(async () => {
            const irisBaseUrl = this.getIrisBaseUrl();
            const authorization = this.getIrisAuthorization();
            const params = new URLSearchParams({ bank: bankCode, account: accountNumber });
            const abortController = new AbortController();
            const timeout = setTimeout(() => abortController.abort(), 15000);
            let response;
            try {
                response = await fetch(`${irisBaseUrl}/api/v1/account_validation?${params.toString()}`, {
                    method: 'GET',
                    headers: { Authorization: `Basic ${authorization}` },
                    signal: abortController.signal,
                });
            }
            catch (err) {
                clearTimeout(timeout);
                this.logger.error(`Iris account inquiry network error: ${err.message}`);
                throw new common_1.ServiceUnavailableException({
                    code: 'BANK_VERIFICATION_UNAVAILABLE',
                    message: 'Bank account verification service is temporarily unavailable',
                });
            }
            finally {
                clearTimeout(timeout);
            }
            if (response.status === 404 || response.status === 400) {
                throw new common_1.BadRequestException({
                    code: 'BANK_ACCOUNT_NOT_FOUND',
                    message: 'Bank account not found or invalid',
                });
            }
            if (!response.ok) {
                this.logger.error(`Iris account inquiry failed [${response.status}] for bank=${bankCode}`);
                throw new common_1.ServiceUnavailableException({
                    code: 'BANK_VERIFICATION_UNAVAILABLE',
                    message: 'Bank account verification service is temporarily unavailable',
                });
            }
            const body = (await response.json());
            const accountName = body['account_name'];
            const accountNo = body['account_no'];
            if (!accountName || !accountNo) {
                throw new common_1.BadRequestException({
                    code: 'BANK_ACCOUNT_NOT_FOUND',
                    message: 'Bank account not found or invalid',
                });
            }
            return {
                accountName,
                accountNo,
                bankCode,
            };
        });
    }
    async createIrisPayout(params) {
        return this.irisCircuitBreaker.execute(async () => {
            const irisBaseUrl = this.getIrisBaseUrl();
            const authorization = this.getIrisAuthorization();
            const abortController = new AbortController();
            const timeout = setTimeout(() => abortController.abort(), 30000);
            let response;
            try {
                response = await fetch(`${irisBaseUrl}/api/v1/payouts`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Basic ${authorization}`,
                        'X-Idempotency-Key': params.referenceNo,
                    },
                    body: JSON.stringify({
                        payouts: [
                            {
                                beneficiary_name: params.beneficiaryName,
                                beneficiary_account: params.beneficiaryAccount,
                                beneficiary_bank: params.beneficiaryBank,
                                beneficiary_email: params.beneficiaryEmail || undefined,
                                amount: String(params.amount),
                                notes: `Withdrawal ${params.referenceNo}`,
                            },
                        ],
                    }),
                    signal: abortController.signal,
                });
            }
            catch (err) {
                clearTimeout(timeout);
                if (err.name === 'AbortError') {
                    this.logger.warn(`Iris payout timed out for reference: ${params.referenceNo} — checking status before marking failed`);
                    try {
                        const statusResult = await this.getIrisPayoutStatus(params.referenceNo);
                        const acceptableStatuses = ['queued', 'processed', 'completed', 'processing'];
                        if (acceptableStatuses.includes(statusResult.status)) {
                            this.logger.log(`Iris payout confirmed via status check: referenceNo=${params.referenceNo} status=${statusResult.status}`);
                            return;
                        }
                    }
                    catch (statusErr) {
                        this.logger.error(`Iris payout status check also failed for reference: ${params.referenceNo}: ${statusErr.message}`);
                    }
                    throw new common_1.ServiceUnavailableException({
                        code: 'IRIS_PAYOUT_TIMEOUT',
                        message: 'Payout request timed out. Please check the status later.',
                    });
                }
                this.logger.error(`Iris payout network error for reference: ${params.referenceNo}: ${err.message}`);
                throw new common_1.ServiceUnavailableException({
                    code: 'IRIS_PAYOUT_NETWORK_ERROR',
                    message: 'Payout service is temporarily unavailable. Please try again later.',
                });
            }
            finally {
                clearTimeout(timeout);
            }
            if (!response.ok) {
                await response.text().catch(() => undefined);
                this.logger.error(`Iris payout failed [${response.status}]. Reference: ${params.referenceNo}. Provider response body omitted to protect beneficiary data.`);
                throw new common_1.ServiceUnavailableException({
                    code: 'IRIS_PAYOUT_FAILED',
                    message: 'Payout processing failed. Please try again later.',
                });
            }
            let responseBody;
            try {
                responseBody = (await response.json());
            }
            catch {
                this.logger.error(`Iris payout response not valid JSON. Reference: ${params.referenceNo}`);
                throw new common_1.ServiceUnavailableException({
                    code: 'IRIS_PAYOUT_INVALID_RESPONSE',
                    message: 'Payout service returned an invalid response. Please try again later.',
                });
            }
            const payouts = responseBody['payouts'];
            if (!payouts || payouts.length === 0) {
                this.logger.error(`Iris payout response missing payouts array. Reference: ${params.referenceNo}. Provider response body omitted to protect beneficiary data.`);
                throw new common_1.ServiceUnavailableException({
                    code: 'IRIS_PAYOUT_EMPTY_RESPONSE',
                    message: 'Payout service returned an incomplete response. Please try again later.',
                });
            }
            const returnedReference = String(payouts[0]['reference_no'] ?? payouts[0]['referenceNo'] ?? '');
            if (returnedReference !== params.referenceNo) {
                this.logger.error(`Iris payout response reference mismatch. Reference: ${params.referenceNo}`);
                throw new common_1.ServiceUnavailableException({
                    code: 'IRIS_PAYOUT_REFERENCE_MISMATCH',
                    message: 'Payout provider returned an unexpected reference. Please check the status later.',
                });
            }
            const payoutStatus = String(payouts[0]['status'] ?? '').toLowerCase();
            const acceptableStatuses = ['queued', 'processed', 'completed', 'processing'];
            if (!acceptableStatuses.includes(payoutStatus)) {
                this.logger.error(`Iris payout unexpected status. Reference: ${params.referenceNo}. Status: ${payoutStatus}. Provider response body omitted to protect beneficiary data.`);
                throw new common_1.ServiceUnavailableException({
                    code: 'IRIS_PAYOUT_UNEXPECTED_STATUS',
                    message: 'Payout returned an unexpected status. Please contact support.',
                });
            }
            this.logger.log(`Iris payout initiated: referenceNo=${params.referenceNo} amount=${params.amount} status=${payoutStatus}`);
        });
    }
    async getIrisPayoutStatus(referenceNo) {
        return this.irisCircuitBreaker.execute(async () => {
            const irisBaseUrl = this.getIrisBaseUrl();
            const authorization = this.getIrisAuthorization();
            const abortController = new AbortController();
            const timeout = setTimeout(() => abortController.abort(), 15000);
            let response;
            try {
                response = await fetch(`${irisBaseUrl}/api/v1/payouts?reference_no=${encodeURIComponent(referenceNo)}`, {
                    method: 'GET',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Basic ${authorization}`,
                    },
                    signal: abortController.signal,
                });
            }
            catch (err) {
                clearTimeout(timeout);
                this.logger.error(`Iris payout status check network error for reference: ${referenceNo}: ${err.message}`);
                throw new common_1.ServiceUnavailableException({
                    code: 'IRIS_PAYOUT_STATUS_UNAVAILABLE',
                    message: 'Unable to retrieve payout status. Please try again later.',
                });
            }
            finally {
                clearTimeout(timeout);
            }
            if (!response.ok) {
                this.logger.error(`Iris payout status check failed [${response.status}] for reference: ${referenceNo}`);
                throw new common_1.ServiceUnavailableException({
                    code: 'IRIS_PAYOUT_STATUS_UNAVAILABLE',
                    message: 'Unable to retrieve payout status. Please try again later.',
                });
            }
            let body;
            try {
                body = (await response.json());
            }
            catch {
                this.logger.error(`Iris payout status response not valid JSON for reference: ${referenceNo}`);
                throw new common_1.ServiceUnavailableException({
                    code: 'IRIS_PAYOUT_STATUS_INVALID',
                    message: 'Unable to parse payout status response. Please try again later.',
                });
            }
            const payouts = body['payouts'];
            const payout = payouts?.find(candidate => String(candidate['reference_no'] ?? candidate['referenceNo'] ?? '') === referenceNo);
            if (!payout) {
                return { status: 'not_found', referenceNo };
            }
            return {
                status: String(payout['status'] ?? 'unknown').toLowerCase(),
                referenceNo,
            };
        });
    }
};
exports.MidtransService = MidtransService;
exports.MidtransService = MidtransService = MidtransService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], MidtransService);
