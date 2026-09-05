import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';
export interface FeeConfig {
    kahadeFeeRateBps: number;
    kahadePlusFeeRateBps: number;
}
interface FeeCalculationParams {
    orderValue: number;
    feeResponsibility: 'BUYER' | 'SELLER' | 'SPLIT';
    isKahadePlus: boolean;
    voucherDiscount?: number;
    voucherDiscountSen?: bigint;
}
interface FeeCalculationResult {
    feeAmount: bigint;
    buyerFeeAmount: bigint;
    sellerFeeAmount: bigint;
    buyerPayAmount: bigint;
    sellerReceiveAmount: bigint;
    voucherDiscount: bigint;
    feeRate: number;
}
export declare class FeeCalculatorService {
    private configService;
    private redis;
    constructor(configService: ConfigService, redis: RedisService);
    getFeeConfig(): Promise<FeeConfig>;
    invalidateFeeConfigCache(): Promise<void>;
    private resolveRateBps;
    private getFeeRateBps;
    getFeeRate(isKahadePlus: boolean, feeConfig?: FeeConfig): number;
    getStandardFeeSen(orderValueSen: bigint, feeConfig?: FeeConfig): bigint;
    getPlusSavingsSen(orderValueSen: bigint, feeConfig?: FeeConfig): bigint;
    calculateFee(params: FeeCalculationParams, feeConfig?: FeeConfig): FeeCalculationResult;
    private validateInvariants;
}
export {};
