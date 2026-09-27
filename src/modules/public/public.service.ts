import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { OpsSettingsService } from '../ops-settings/ops-settings.service';
import { SUBSCRIPTION_PLANS_CACHE } from '../../common/constants/redis-keys';

const SUBSCRIPTION_PLANS_TTL = 300;

/**
 * Agregat statistik publik untuk landing page. Read-only dan tanpa PII:
 * hanya COUNT / AVG. Tidak ada data individual user yang diekspos.
 */
export interface PublicStats {
  /** Order escrow berstatus COMPLETED (dana sudah cair ke penjual). */
  transactionsCount: number;
  /** User aktif dan tidak di-ban. */
  usersCount: number;
  /** Kota unik (case-insensitive) dari kota asal/tujuan pengiriman. */
  citiesCount: number;
  /** Rata-rata bintang ulasan yang tampil, 1 desimal; null bila belum ada. */
  ratingAvg: number | null;
}

function finiteNumber(value: unknown, fallback: number, minimum?: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && (minimum === undefined || parsed >= minimum) ? parsed : fallback;
}

@Injectable()
export class PublicService {
  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private configService: ConfigService,
    private opsSettings: OpsSettingsService,
  ) {}

  // Cache public configs in Redis (TTL 5min) to avoid per-request DB queries.
  // Since system
  // configs change rarely (admin updates only), 5-minute caching is safe and
  // dramatically reduces DB load from unauthenticated traffic.
  private readonly PUBLIC_CONFIGS_CACHE_KEY = 'public:system:configs';
  private readonly PUBLIC_CONFIGS_TTL_SECONDS = 300; // 5 minutes
  private readonly PUBLIC_STATS_CACHE_KEY = 'public:stats:aggregate';
  private readonly PUBLIC_STATS_TTL_SECONDS = 600; // 10 minutes

  /**
   * Agregat statistik publik. Di-cache 10 menit di Redis agar landing page
   * tidak menghantam DB tiap load. Redis yang gagal = fall through ke DB;
   * tulis cache yang gagal tidak menggagalkan response.
   */
  async getPublicStats(): Promise<PublicStats> {
    let cached: string | null = null;
    try {
      cached = await this.redis.get(this.PUBLIC_STATS_CACHE_KEY);
    } catch {
      // Redis hanya optimisasi untuk path baca publik ini; lanjut ke DB.
    }
    if (cached) {
      try {
        return JSON.parse(cached) as PublicStats;
      } catch {
        // Cache korup — hitung ulang dari DB.
      }
    }

    const [transactionsCount, usersCount, ratingAgg, originCities, destCities] =
      await Promise.all([
        this.prisma.order.count({ where: { status: 'COMPLETED' } }),
        this.prisma.user.count({ where: { isActive: true, isBanned: false } }),
        this.prisma.rating.aggregate({
          _avg: { stars: true },
          where: { isHidden: false },
        }),
        this.prisma.shipment.groupBy({
          by: ['originCity'],
          where: { originCity: { not: null } },
        }),
        this.prisma.shipment.groupBy({
          by: ['destCity'],
          where: { destCity: { not: null } },
        }),
      ]);

    // Gabung kota asal + tujuan, case-insensitive, abaikan string kosong.
    const cities = new Set<string>();
    for (const row of originCities) {
      const city = row.originCity?.trim().toLowerCase();
      if (city) cities.add(city);
    }
    for (const row of destCities) {
      const city = row.destCity?.trim().toLowerCase();
      if (city) cities.add(city);
    }

    const avgStars = ratingAgg._avg.stars;
    const result: PublicStats = {
      transactionsCount,
      usersCount,
      citiesCount: cities.size,
      ratingAvg: avgStars == null ? null : Math.round(avgStars * 10) / 10,
    };

    try {
      await this.redis.setex(
        this.PUBLIC_STATS_CACHE_KEY,
        this.PUBLIC_STATS_TTL_SECONDS,
        JSON.stringify(result),
      );
    } catch {
      // Kegagalan tulis cache tidak boleh mengubah response publik yang sukses.
    }
    return result;
  }

  async getPublicConfigs(): Promise<{ configs: Array<{ key: string; value: string; description: string | null; dataType: string; updatedAt: Date }> }> {
    let cached: string | null = null;
    try {
      cached = await this.redis.get(this.PUBLIC_CONFIGS_CACHE_KEY);
    } catch {
      // Redis is an optimization for this public read path; fall through to DB.
    }
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {
        // Cache parse error — fall through to DB query
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
    } catch {
      // A cache write must not turn a successful public DB read into a 5xx.
    }
    return result;
  }

  getFeeSchedule(): Record<string, unknown> {
    const kahadeFeeRate = finiteNumber(this.configService.get<number>('app.kahadeFeeRate'), 2.5, 0);
    const kahadePlusFeeRate = finiteNumber(this.configService.get<number>('app.kahadePlusFeeRate'), 0.5, 0);
    const orderMinValue = finiteNumber(this.configService.get<number>('app.orderMinValue'), 10000, 0);
    const orderMaxValue = finiteNumber(this.configService.get<number>('app.orderMaxValue'), 1000000000, orderMinValue);
    // Standard-fee clamp bounds in IDR (sen → IDR).  Mirrors FEE_MIN_SEN /
    // FEE_MAX_SEN in app.constants.ts.  Surfaced here so clients can render
    // the full fee policy without hardcoding the bounds.
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

  getBanks(): { banks: Array<{ code: string; name: string }> } {
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

  async getExchangeRates(): Promise<Record<string, unknown>> {
    const cacheKey = 'public:exchange:rates';
    let cached: string | null = null;
    try {
      cached = await this.redis.get(cacheKey);
    } catch {
      // Continue with the source of truth when Redis is unavailable.
    }
    if (cached) {
      try {
        return JSON.parse(cached) as Record<string, unknown>;
      } catch {
        // fall through
      }
    }

    const rates = await this.prisma.systemConfig.findMany({
      where: { key: { startsWith: 'exchange_rate_' }, isPublic: true },
      select: { key: true, value: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });

    const rateMap: Record<string, number> = {};
    const validRates = rates.filter((r) => {
      const parsed = Number(r.value);
      if (!Number.isFinite(parsed) || parsed <= 0) return false;
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

    const result: Record<string, unknown> = {
      rates: rateMap,
      baseCurrency: 'IDR',
      updatedAt: validRates.length > 0 ? validRates[0].updatedAt : new Date(),
      source: isFallback ? 'fallback' : 'system-config',
      isFallback,
    };

    try {
      await this.redis.setex(cacheKey, 300, JSON.stringify(result));
    } catch {
      // Cache write failure is non-fatal for the public rate response.
    }
    return result;
  }

  getAppVersion(): Record<string, unknown> {
    const iosMinimum = this.configService.get<string>('app.iosMinimumVersion') ?? '1.0.0';
    const androidMinimum = this.configService.get<string>('app.androidMinimumVersion') ?? '1.0.0';
    const iosLatest = this.configService.get<string>('app.iosLatestVersion') ?? '1.0.0';
    const androidLatest = this.configService.get<string>('app.androidLatestVersion') ?? '1.0.0';

    return {
      ios: {
        latestVersion: iosLatest,
        minimumVersion: iosMinimum,
        storeUrl: this.configService.get<string>('app.iosStoreUrl') ?? '',
      },
      android: {
        latestVersion: androidLatest,
        minimumVersion: androidMinimum,
        storeUrl: this.configService.get<string>('app.androidStoreUrl') ?? '',
      },
      checkIntervalMs: this.configService.get<number>('app.updateCheckIntervalMs') ?? 21600000,
    };
  }

  async getSubscriptionPlans(): Promise<Record<string, unknown>> {
    let cached: string | null = null;
    try {
      cached = await this.redis.get(SUBSCRIPTION_PLANS_CACHE);
    } catch {
      // Continue with configuration when Redis is unavailable.
    }
    if (cached) {
      try {
        return JSON.parse(cached) as Record<string, unknown>;
      } catch {
        // Cache parse error — fall through to DB query
      }
    }

    const monthlyPrice = finiteNumber(this.configService.get<number>('app.subscriptionMonthlyPrice'), 99000, 0);
    const yearlyPrice = finiteNumber(this.configService.get<number>('app.subscriptionYearlyPrice'), 899000, 0);
    const kahadePlusFeeRate = finiteNumber(this.configService.get<number>('app.kahadePlusFeeRate'), 0.5, 0);
    const feeSavingsLimit = finiteNumber(this.configService.get<number>('app.feeSavingsLimit'), 5000000, 0);
    const feeSavingsLimitFormatted = new Intl.NumberFormat('id-ID').format(feeSavingsLimit);

    const result: Record<string, unknown> = {
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
          plan: 'YEARLY',
          name: 'Kahade Plus Yearly',
          price: yearlyPrice,
          currency: 'IDR',
          period: '12 months',
          feeRate: kahadePlusFeeRate,
          feeSavingsLimit,
          features: [
            `Reduced fee rate: ${kahadePlusFeeRate}%`,
            `Fee savings up to Rp ${feeSavingsLimitFormatted} per period`,
            'Priority support',
            'Kahade Plus badge',
            `Save ${monthlyPrice > 0 ? Math.round(((monthlyPrice * 12 - yearlyPrice) / (monthlyPrice * 12)) * 100) : 0}% vs monthly`,
          ],
        },
      ],
    };

    try {
      await this.redis.setex(SUBSCRIPTION_PLANS_CACHE, SUBSCRIPTION_PLANS_TTL, JSON.stringify(result));
    } catch {
      // Cache write failure is non-fatal for the public plans response.
    }
    return result;
  }

  /**
   * Item 9 (batch 2026-09-28) — Status maintenance untuk splash check.
   * TANPA auth. Dibaca dari app_settings via OpsSettingsService (cache 60 dtk).
   * Selalu bisa diakses — dikecualikan dari MaintenanceMiddleware.
   */
  getMaintenanceStatus(): { enabled: boolean; message: string | null } {
    return {
      enabled: this.opsSettings.get('MAINTENANCE_MODE')?.trim().toLowerCase() === 'true',
      message: this.opsSettings.get('MAINTENANCE_MESSAGE')?.trim() || null,
    };
  }
}
