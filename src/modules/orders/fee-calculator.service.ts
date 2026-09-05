import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { RedisService } from '../../redis/redis.service';
import { FEE_CONFIG_CACHE } from '../../common/constants/redis-keys';
import { toSen } from '../../common/utils/currency.util';
import { FEE_MIN_SEN, FEE_MAX_SEN } from '../../common/constants/app.constants';

const FEE_CONFIG_TTL = 300;
const FEE_CONFIG_LOCK_TTL = 5;

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

@Injectable()
export class FeeCalculatorService {
  constructor(
    private configService: ConfigService,
    private redis: RedisService,
  ) {}

  /**
   * Returns the fee configuration, using a Redis cache-aside pattern with a 5-minute TTL.
   *
   * Hot paths (order creation, fee estimate) should call this ONCE at the start of the
   * request and pass the returned `FeeConfig` into `calculateFee()`.  This ensures a
   * single Redis read per request rather than one per `getFeeRateBps()` call.
   *
   * On a cache miss the values are read from ConfigService (populated from env vars) and
   * written back to Redis so that subsequent calls hit the cache.
   *
   * This also lets a future migration to DB-backed fee rates be done here without
   * changing any callers — only this method needs updating.
   */
  async getFeeConfig(): Promise<FeeConfig> {
    const cached = await this.redis.get(FEE_CONFIG_CACHE);
    if (cached) {
      try {
        return JSON.parse(cached) as FeeConfig;
      } catch {
        await this.redis.del(FEE_CONFIG_CACHE);
      }
    }

    const lockKey = `${FEE_CONFIG_CACHE}:lock`;
    const lockToken = randomBytes(16).toString('hex');
    let lockAcquired = false;
    try {
      lockAcquired = await this.redis.setNx(lockKey, lockToken, FEE_CONFIG_LOCK_TTL);
    } catch {
      // Redis down — fall through to direct config read
    }

    if (!lockAcquired) {
      for (let i = 0; i < 5; i++) {
        await new Promise<void>((r) => setTimeout(r, 100));
        const retry = await this.redis.get(FEE_CONFIG_CACHE);
        if (retry) {
          try { return JSON.parse(retry) as FeeConfig; } catch { break; }
        }
      }
      return {
        kahadeFeeRateBps: this.resolveRateBps(false),
        kahadePlusFeeRateBps: this.resolveRateBps(true),
      };
    }

    try {
      const config: FeeConfig = {
        kahadeFeeRateBps: this.resolveRateBps(false),
        kahadePlusFeeRateBps: this.resolveRateBps(true),
      };
      await this.redis.setex(FEE_CONFIG_CACHE, FEE_CONFIG_TTL, JSON.stringify(config));
      return config;
    } finally {
      await this.redis.releaseLock(lockKey, lockToken);
    }
  }

  /**
   * Invalidates the fee-config cache entry.
   * Call this whenever an admin updates fee-rate settings.
   */
  async invalidateFeeConfigCache(): Promise<void> {
    await this.redis.del(FEE_CONFIG_CACHE);
  }

  /**
   * Reads the fee rate in basis-points from ConfigService synchronously.
   * Used to populate the cache on a miss.
   *
   * Example: KAHADE_FEE_RATE_BPS=150 → 1.50%, KAHADE_PLUS_FEE_RATE_BPS=50 → 0.50%.
   * Falls back to the legacy float env var when the integer BPS var is not set.
   */
  private resolveRateBps(isKahadePlus: boolean): number {
    if (isKahadePlus) {
      const bps = this.configService.get<number>('app.kahadePlusFeeRateBps');
      if (bps !== undefined && !isNaN(bps)) return bps;
      const rate = this.configService.get<number>('app.kahadePlusFeeRate') ?? 0.5;
      return Math.round(rate * 100);
    } else {
      const bps = this.configService.get<number>('app.kahadeFeeRateBps');
      if (bps !== undefined && !isNaN(bps)) return bps;
      const rate = this.configService.get<number>('app.kahadeFeeRate') ?? 1.5;
      return Math.round(rate * 100);
    }
  }

  /**
   * Returns the fee rate in basis points as a BigInt.
   *
   * When a pre-fetched `feeConfig` is provided (from `getFeeConfig()`) the cached value
   * is used directly; otherwise the value is resolved synchronously from ConfigService.
   *
   * Using BigInt arithmetic throughout ensures the calculation is deterministic:
   *   feeAmount = (orderValueSen * feeRateBps) / 10_000
   * No Math.round(), no floating-point conversion, no precision loss.
   */
  private getFeeRateBps(isKahadePlus: boolean, feeConfig?: FeeConfig): bigint {
    if (feeConfig) {
      return BigInt(isKahadePlus ? feeConfig.kahadePlusFeeRateBps : feeConfig.kahadeFeeRateBps);
    }
    return BigInt(this.resolveRateBps(isKahadePlus));
  }

  /**
   * Returns fee rate as a human-readable percentage (for response serialization only).
   *
   * Pass the pre-fetched `feeConfig` from `getFeeConfig()` to use the cached value.
   */
  getFeeRate(isKahadePlus: boolean, feeConfig?: FeeConfig): number {
    return Number(this.getFeeRateBps(isKahadePlus, feeConfig)) / 100;
  }

  /**
   * Returns the clamped standard fee for an order value (without any reduction
   * from Kahade Plus, voucher, rank, or promo).  This is the canonical "fee
   * before reductions" value and MUST be used by any caller that needs to base
   * a percentage reduction on the standard fee — using the raw, unclamped
   * `orderValue × rate` would over- or under-discount near the clamp bounds.
   */
  getStandardFeeSen(orderValueSen: bigint, feeConfig?: FeeConfig): bigint {
    if (orderValueSen <= BigInt(0)) return BigInt(0);
    const rateBps = this.getFeeRateBps(false, feeConfig);
    let fee = (orderValueSen * rateBps) / BigInt(10_000);
    const MIN_FEE = BigInt(FEE_MIN_SEN);
    const MAX_FEE = BigInt(FEE_MAX_SEN);
    if (fee < MIN_FEE) fee = MIN_FEE;
    if (fee > MAX_FEE) fee = MAX_FEE;
    return fee;
  }

  /**
   * Returns the savings a Kahade Plus subscriber received on a single order:
   *   savings = clampedStandardFee − effectivePlusFee
   * where `effectivePlusFee = min(orderValue × plusRate, clampedStandardFee)`.
   *
   * Both sides use the same clamp semantics as `calculateFee`, so the result
   * matches what the buyer was actually charged.  Use this when accounting
   * against the subscription's `feeSavingsLimit`.
   */
  getPlusSavingsSen(orderValueSen: bigint, feeConfig?: FeeConfig): bigint {
    if (orderValueSen <= BigInt(0)) return BigInt(0);
    const standardFee = this.getStandardFeeSen(orderValueSen, feeConfig);
    const plusRateBps = this.getFeeRateBps(true, feeConfig);
    const plusFeeRaw = (orderValueSen * plusRateBps) / BigInt(10_000);
    const effectivePlusFee = plusFeeRaw < standardFee ? plusFeeRaw : standardFee;
    return standardFee > effectivePlusFee ? standardFee - effectivePlusFee : BigInt(0);
  }

  /**
   * Calculates all fee amounts for an order.
   *
   * Pass the pre-fetched `feeConfig` from `getFeeConfig()` to use the Redis-cached fee
   * rates instead of reading from ConfigService on every call.  Hot paths (order creation,
   * fee estimate) should always supply this parameter.
   */
  calculateFee(params: FeeCalculationParams, feeConfig?: FeeConfig): FeeCalculationResult {
    const { orderValue, feeResponsibility, isKahadePlus, voucherDiscount = 0, voucherDiscountSen: directSen } = params;

    const orderValueSen = toSen(orderValue);
    const voucherDiscountSen = directSen ?? toSen(voucherDiscount);

    // ── 1. Standard fee: orderValue × standard rate (e.g. 2.5%), clamped to
    //       [Rp 5.000, Rp 250.000].  This clamp is the contract for non-discounted
    //       orders — it ALWAYS holds when no reduction is applied.
    const standardRateBps = this.getFeeRateBps(false, feeConfig);
    const MIN_FEE = BigInt(FEE_MIN_SEN);
    const MAX_FEE = BigInt(FEE_MAX_SEN);
    let standardFee = (orderValueSen * standardRateBps) / BigInt(10_000);
    if (orderValueSen > BigInt(0)) {
      if (standardFee < MIN_FEE) standardFee = MIN_FEE;
      if (standardFee > MAX_FEE) standardFee = MAX_FEE;
    }

    // ── 2. Subscription reduction (Kahade Plus): subscriber rate (e.g. 0.5%),
    //       guaranteed never higher than the clamped standard fee.  The Plus
    //       fee is allowed to fall below MIN_FEE — that's the whole point of
    //       the subscription discount.
    let feeAmount = standardFee;
    if (isKahadePlus) {
      const plusRateBps = this.getFeeRateBps(true, feeConfig);
      const plusFee = (orderValueSen * plusRateBps) / BigInt(10_000);
      feeAmount = plusFee < standardFee ? plusFee : standardFee;
    }

    // ── 3. Voucher reduction (capped at the current fee, floor at 0).
    const cappedVoucherDiscountSen = voucherDiscountSen > feeAmount ? feeAmount : voucherDiscountSen;
    if (cappedVoucherDiscountSen > BigInt(0)) {
      feeAmount = feeAmount - cappedVoucherDiscountSen;
    }

    // Split fee based on responsibility
    let buyerFeeAmount: bigint;
    let sellerFeeAmount: bigint;

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
        // BigInt division truncates; odd-sen remainder is absorbed by seller
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

  private validateInvariants(params: {
    buyerFeeAmount: bigint;
    sellerFeeAmount: bigint;
    feeAmount: bigint;
    buyerPayAmount: bigint;
    sellerReceiveAmount: bigint;
    orderValueSen: bigint;
  }): void {
    const { buyerFeeAmount, sellerFeeAmount, feeAmount, buyerPayAmount, sellerReceiveAmount, orderValueSen } = params;

    if (buyerFeeAmount + sellerFeeAmount !== feeAmount) {
      throw new InternalServerErrorException({ code: 'FEE_INVARIANT_VIOLATED', message: 'Fee split invariant violated' });
    }
    if (buyerPayAmount !== orderValueSen + buyerFeeAmount) {
      throw new InternalServerErrorException({ code: 'FEE_INVARIANT_VIOLATED', message: 'Buyer pay amount invariant violated' });
    }
    if (sellerReceiveAmount !== orderValueSen - sellerFeeAmount) {
      throw new InternalServerErrorException({ code: 'FEE_INVARIANT_VIOLATED', message: 'Seller receive amount invariant violated' });
    }
  }
}
