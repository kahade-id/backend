"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FeeCalculatorService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const crypto_1 = require("crypto");
const redis_service_1 = require("../../redis/redis.service");
const redis_keys_1 = require("../../common/constants/redis-keys");
const currency_util_1 = require("../../common/utils/currency.util");
const app_constants_1 = require("../../common/constants/app.constants");
const FEE_CONFIG_TTL = 300;
const FEE_CONFIG_LOCK_TTL = 5;
let FeeCalculatorService = class FeeCalculatorService {
    constructor(configService, redis) {
        this.configService = configService;
        this.redis = redis;
    }
    async getFeeConfig() {
        const cached = await this.redis.get(redis_keys_1.FEE_CONFIG_CACHE);
        if (cached) {
            try {
                return JSON.parse(cached);
            }
            catch {
                await this.redis.del(redis_keys_1.FEE_CONFIG_CACHE);
            }
        }
        const lockKey = `${redis_keys_1.FEE_CONFIG_CACHE}:lock`;
        const lockToken = (0, crypto_1.randomBytes)(16).toString('hex');
        let lockAcquired = false;
        try {
            lockAcquired = await this.redis.setNx(lockKey, lockToken, FEE_CONFIG_LOCK_TTL);
        }
        catch {
        }
        if (!lockAcquired) {
            for (let i = 0; i < 5; i++) {
                await new Promise((r) => setTimeout(r, 100));
                const retry = await this.redis.get(redis_keys_1.FEE_CONFIG_CACHE);
                if (retry) {
                    try {
                        return JSON.parse(retry);
                    }
                    catch {
                        break;
                    }
                }
            }
            return {
                kahadeFeeRateBps: this.resolveRateBps(false),
                kahadePlusFeeRateBps: this.resolveRateBps(true),
            };
        }
        try {
            const config = {
                kahadeFeeRateBps: this.resolveRateBps(false),
                kahadePlusFeeRateBps: this.resolveRateBps(true),
            };
            await this.redis.setex(redis_keys_1.FEE_CONFIG_CACHE, FEE_CONFIG_TTL, JSON.stringify(config));
            return config;
        }
        finally {
            await this.redis.releaseLock(lockKey, lockToken);
        }
    }
    async invalidateFeeConfigCache() {
        await this.redis.del(redis_keys_1.FEE_CONFIG_CACHE);
    }
    resolveRateBps(isKahadePlus) {
        if (isKahadePlus) {
            const bps = this.configService.get('app.kahadePlusFeeRateBps');
            if (bps !== undefined && !isNaN(bps))
                return bps;
            const rate = this.configService.get('app.kahadePlusFeeRate') ?? 0.5;
            return Math.round(rate * 100);
        }
        else {
            const bps = this.configService.get('app.kahadeFeeRateBps');
            if (bps !== undefined && !isNaN(bps))
                return bps;
            const rate = this.configService.get('app.kahadeFeeRate') ?? 1.5;
            return Math.round(rate * 100);
        }
    }
    getFeeRateBps(isKahadePlus, feeConfig) {
        if (feeConfig) {
            return BigInt(isKahadePlus ? feeConfig.kahadePlusFeeRateBps : feeConfig.kahadeFeeRateBps);
        }
        return BigInt(this.resolveRateBps(isKahadePlus));
    }
    getFeeRate(isKahadePlus, feeConfig) {
        return Number(this.getFeeRateBps(isKahadePlus, feeConfig)) / 100;
    }
    getStandardFeeSen(orderValueSen, feeConfig) {
        if (orderValueSen <= BigInt(0))
            return BigInt(0);
        const rateBps = this.getFeeRateBps(false, feeConfig);
        let fee = (orderValueSen * rateBps) / BigInt(10_000);
        const MIN_FEE = BigInt(app_constants_1.FEE_MIN_SEN);
        const MAX_FEE = BigInt(app_constants_1.FEE_MAX_SEN);
        if (fee < MIN_FEE)
            fee = MIN_FEE;
        if (fee > MAX_FEE)
            fee = MAX_FEE;
        return fee;
    }
    getPlusSavingsSen(orderValueSen, feeConfig) {
        if (orderValueSen <= BigInt(0))
            return BigInt(0);
        const standardFee = this.getStandardFeeSen(orderValueSen, feeConfig);
        const plusRateBps = this.getFeeRateBps(true, feeConfig);
        const plusFeeRaw = (orderValueSen * plusRateBps) / BigInt(10_000);
        const effectivePlusFee = plusFeeRaw < standardFee ? plusFeeRaw : standardFee;
        return standardFee > effectivePlusFee ? standardFee - effectivePlusFee : BigInt(0);
    }
    calculateFee(params, feeConfig) {
        const { orderValue, feeResponsibility, isKahadePlus, voucherDiscount = 0, voucherDiscountSen: directSen } = params;
        const orderValueSen = (0, currency_util_1.toSen)(orderValue);
        const voucherDiscountSen = directSen ?? (0, currency_util_1.toSen)(voucherDiscount);
        const standardRateBps = this.getFeeRateBps(false, feeConfig);
        const MIN_FEE = BigInt(app_constants_1.FEE_MIN_SEN);
        const MAX_FEE = BigInt(app_constants_1.FEE_MAX_SEN);
        let standardFee = (orderValueSen * standardRateBps) / BigInt(10_000);
        if (orderValueSen > BigInt(0)) {
            if (standardFee < MIN_FEE)
                standardFee = MIN_FEE;
            if (standardFee > MAX_FEE)
                standardFee = MAX_FEE;
        }
        let feeAmount = standardFee;
        if (isKahadePlus) {
            const plusRateBps = this.getFeeRateBps(true, feeConfig);
            const plusFee = (orderValueSen * plusRateBps) / BigInt(10_000);
            feeAmount = plusFee < standardFee ? plusFee : standardFee;
        }
        const cappedVoucherDiscountSen = voucherDiscountSen > feeAmount ? feeAmount : voucherDiscountSen;
        if (cappedVoucherDiscountSen > BigInt(0)) {
            feeAmount = feeAmount - cappedVoucherDiscountSen;
        }
        let buyerFeeAmount;
        let sellerFeeAmount;
        switch (feeResponsibility) {
            case 'BUYER':
                buyerFeeAmount = feeAmount;
                sellerFeeAmount = BigInt(0);
                break;
            case 'SELLER':
                buyerFeeAmount = BigInt(0);
                sellerFeeAmount = feeAmount;
                break;
            case 'SPLIT':
                buyerFeeAmount = feeAmount / BigInt(2);
                sellerFeeAmount = feeAmount - buyerFeeAmount;
                break;
            default:
                buyerFeeAmount = feeAmount;
                sellerFeeAmount = BigInt(0);
        }
        const buyerPayAmount = orderValueSen + buyerFeeAmount;
        const sellerReceiveAmount = orderValueSen - sellerFeeAmount;
        this.validateInvariants({ buyerFeeAmount, sellerFeeAmount, feeAmount, buyerPayAmount, sellerReceiveAmount, orderValueSen });
        return {
            feeAmount,
            buyerFeeAmount,
            sellerFeeAmount,
            buyerPayAmount,
            sellerReceiveAmount,
            voucherDiscount: cappedVoucherDiscountSen,
            feeRate: this.getFeeRate(isKahadePlus, feeConfig),
        };
    }
    validateInvariants(params) {
        const { buyerFeeAmount, sellerFeeAmount, feeAmount, buyerPayAmount, sellerReceiveAmount, orderValueSen } = params;
        if (buyerFeeAmount + sellerFeeAmount !== feeAmount) {
            throw new common_1.InternalServerErrorException({ code: 'FEE_INVARIANT_VIOLATED', message: 'Fee split invariant violated' });
        }
        if (buyerPayAmount !== orderValueSen + buyerFeeAmount) {
            throw new common_1.InternalServerErrorException({ code: 'FEE_INVARIANT_VIOLATED', message: 'Buyer pay amount invariant violated' });
        }
        if (sellerReceiveAmount !== orderValueSen - sellerFeeAmount) {
            throw new common_1.InternalServerErrorException({ code: 'FEE_INVARIANT_VIOLATED', message: 'Seller receive amount invariant violated' });
        }
    }
};
exports.FeeCalculatorService = FeeCalculatorService;
exports.FeeCalculatorService = FeeCalculatorService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService,
        redis_service_1.RedisService])
], FeeCalculatorService);
