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
exports.PublicService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const prisma_service_1 = require("../../prisma/prisma.service");
const redis_service_1 = require("../../redis/redis.service");
const redis_keys_1 = require("../../common/constants/redis-keys");
const SUBSCRIPTION_PLANS_TTL = 300;
function finiteNumber(value, fallback, minimum) {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) && (minimum === undefined || parsed >= minimum) ? parsed : fallback;
}
let PublicService = class PublicService {
    constructor(prisma, redis, configService) {
        this.prisma = prisma;
        this.redis = redis;
        this.configService = configService;
        this.PUBLIC_CONFIGS_CACHE_KEY = 'public:system:configs';
        this.PUBLIC_CONFIGS_TTL_SECONDS = 300;
    }
    async getPublicConfigs() {
        let cached = null;
        try {
            cached = await this.redis.get(this.PUBLIC_CONFIGS_CACHE_KEY);
        }
        catch {
        }
        if (cached) {
            try {
                return JSON.parse(cached);
            }
            catch {
            }
        }
        const configs = await this.prisma.systemConfig.findMany({
            where: { isPublic: true },
            select: {
                key: true,
                value: true,
                description: true,
                dataType: true,
                updatedAt: true,
            },
            orderBy: { key: 'asc' },
            take: 100,
        });
        const result = { configs };
        try {
            await this.redis.setex(this.PUBLIC_CONFIGS_CACHE_KEY, this.PUBLIC_CONFIGS_TTL_SECONDS, JSON.stringify(result));
        }
        catch {
        }
        return result;
    }
    getFeeSchedule() {
        const kahadeFeeRate = finiteNumber(this.configService.get('app.kahadeFeeRate'), 2.5, 0);
        const kahadePlusFeeRate = finiteNumber(this.configService.get('app.kahadePlusFeeRate'), 0.5, 0);
        const orderMinValue = finiteNumber(this.configService.get('app.orderMinValue'), 10000, 0);
        const orderMaxValue = finiteNumber(this.configService.get('app.orderMaxValue'), 1000000000, orderMinValue);
        const standardFeeMin = 5_000;
        const standardFeeMax = 250_000;
        return {
            feeSchedule: {
                standardFeeRate: kahadeFeeRate,
                kahadePlusFeeRate: kahadePlusFeeRate,
                standardFeeMin,
                standardFeeMax,
                standardFeeDescription: `${kahadeFeeRate}% of order value (min Rp ${standardFeeMin.toLocaleString('id-ID')}, max Rp ${standardFeeMax.toLocaleString('id-ID')})`,
                kahadePlusFeeDescription: `${kahadePlusFeeRate}% of order value (Kahade Plus members)`,
                orderMinValue,
                orderMaxValue,
                currency: 'IDR',
                feeResponsibilityOptions: ['BUYER', 'SELLER', 'SPLIT'],
            },
        };
    }
    getBanks() {
        const banks = [
            { code: 'BCA', name: 'Bank Central Asia' },
            { code: 'BNI', name: 'Bank Negara Indonesia' },
            { code: 'BRI', name: 'Bank Rakyat Indonesia' },
            { code: 'MANDIRI', name: 'Bank Mandiri' },
            { code: 'CIMB', name: 'CIMB Niaga' },
            { code: 'PERMATA', name: 'Bank Permata' },
            { code: 'DANAMON', name: 'Bank Danamon' },
            { code: 'OCBC', name: 'OCBC NISP' },
            { code: 'PANIN', name: 'Bank Panin' },
            { code: 'MEGA', name: 'Bank Mega' },
            { code: 'BTN', name: 'Bank Tabungan Negara' },
            { code: 'BSI', name: 'Bank Syariah Indonesia' },
            { code: 'MAYBANK', name: 'Maybank Indonesia' },
            { code: 'OTHER', name: 'Bank Lainnya' },
        ];
        return { banks };
    }
    async getExchangeRates() {
        const cacheKey = 'public:exchange:rates';
        let cached = null;
        try {
            cached = await this.redis.get(cacheKey);
        }
        catch {
        }
        if (cached) {
            try {
                return JSON.parse(cached);
            }
            catch {
            }
        }
        const rates = await this.prisma.systemConfig.findMany({
            where: { key: { startsWith: 'exchange_rate_' }, isPublic: true },
            select: { key: true, value: true, updatedAt: true },
            orderBy: { updatedAt: 'desc' },
            take: 200,
        });
        const rateMap = {};
        const validRates = rates.filter((r) => {
            const parsed = Number(r.value);
            if (!Number.isFinite(parsed) || parsed <= 0)
                return false;
            rateMap[r.key.replace('exchange_rate_', '').toUpperCase()] = parsed;
            return true;
        });
        const isFallback = validRates.length === 0;
        if (isFallback) {
            rateMap['USD_IDR'] = 15500;
            rateMap['BTC_IDR'] = 800000000;
            rateMap['ETH_IDR'] = 50000000;
            rateMap['USDT_IDR'] = 15500;
        }
        const result = {
            rates: rateMap,
            baseCurrency: 'IDR',
            updatedAt: validRates.length > 0 ? validRates[0].updatedAt : new Date(),
            source: isFallback ? 'fallback' : 'system-config',
            isFallback,
        };
        try {
            await this.redis.setex(cacheKey, 300, JSON.stringify(result));
        }
        catch {
        }
        return result;
    }
    getAppVersion() {
        const iosMinimum = this.configService.get('app.iosMinimumVersion') ?? '1.0.0';
        const androidMinimum = this.configService.get('app.androidMinimumVersion') ?? '1.0.0';
        const iosLatest = this.configService.get('app.iosLatestVersion') ?? '1.0.0';
        const androidLatest = this.configService.get('app.androidLatestVersion') ?? '1.0.0';
        return {
            ios: {
                latestVersion: iosLatest,
                minimumVersion: iosMinimum,
                storeUrl: this.configService.get('app.iosStoreUrl') ?? '',
            },
            android: {
                latestVersion: androidLatest,
                minimumVersion: androidMinimum,
                storeUrl: this.configService.get('app.androidStoreUrl') ?? '',
            },
            checkIntervalMs: this.configService.get('app.updateCheckIntervalMs') ?? 21600000,
        };
    }
    async getSubscriptionPlans() {
        let cached = null;
        try {
            cached = await this.redis.get(redis_keys_1.SUBSCRIPTION_PLANS_CACHE);
        }
        catch {
        }
        if (cached) {
            try {
                return JSON.parse(cached);
            }
            catch {
            }
        }
        const monthlyPrice = finiteNumber(this.configService.get('app.subscriptionMonthlyPrice'), 29000, 0);
        const annualPrice = finiteNumber(this.configService.get('app.subscriptionAnnualPrice'), 299000, 0);
        const kahadePlusFeeRate = finiteNumber(this.configService.get('app.kahadePlusFeeRate'), 0.5, 0);
        const feeSavingsLimit = finiteNumber(this.configService.get('app.feeSavingsLimit'), 5000000, 0);
        const feeSavingsLimitFormatted = new Intl.NumberFormat('id-ID').format(feeSavingsLimit);
        const result = {
            plans: [
                {
                    plan: 'MONTHLY',
                    name: 'Kahade Plus Monthly',
                    price: monthlyPrice,
                    currency: 'IDR',
                    period: '1 month',
                    feeRate: kahadePlusFeeRate,
                    feeSavingsLimit,
                    features: [
                        `Reduced fee rate: ${kahadePlusFeeRate}%`,
                        `Fee savings up to Rp ${feeSavingsLimitFormatted} per period`,
                        'Priority support',
                        'Kahade Plus badge',
                    ],
                },
                {
                    plan: 'ANNUAL',
                    name: 'Kahade Plus Annual',
                    price: annualPrice,
                    currency: 'IDR',
                    period: '12 months',
                    feeRate: kahadePlusFeeRate,
                    feeSavingsLimit,
                    features: [
                        `Reduced fee rate: ${kahadePlusFeeRate}%`,
                        `Fee savings up to Rp ${feeSavingsLimitFormatted} per period`,
                        'Priority support',
                        'Kahade Plus badge',
                        `Save ${monthlyPrice > 0 ? Math.round(((monthlyPrice * 12 - annualPrice) / (monthlyPrice * 12)) * 100) : 0}% vs monthly`,
                    ],
                },
            ],
        };
        try {
            await this.redis.setex(redis_keys_1.SUBSCRIPTION_PLANS_CACHE, SUBSCRIPTION_PLANS_TTL, JSON.stringify(result));
        }
        catch {
        }
        return result;
    }
};
exports.PublicService = PublicService;
exports.PublicService = PublicService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService,
        config_1.ConfigService])
], PublicService);
