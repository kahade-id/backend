import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { LocationDto } from './dto/location.dto';

export type AuthLocationEvent =
  | 'login'
  | 'register'
  | 'forgot_password'
  | 'password_reset'
  | 'otp_trigger'
  | 'phone_migration'
  | 'password_change'
  | 'phone_change';

/**
 * Mencatat lokasi presisi pada momen sensitif auth.
 * - Selalu best-effort: kegagalan tulis log TIDAK boleh menggagalkan auth.
 * - Heuristik impossible-travel: bila log terakhir user yang sama berjarak
 *   > 500 km dalam < 2 jam, tandai suspicious=true (murni penanda review,
 *   tidak memblokir).
 */
@Injectable()
export class AuthLocationService {
  private readonly logger = new Logger(AuthLocationService.name);

  constructor(private readonly prisma: PrismaService) {}

  async logEvent(opts: {
    userId?: string | null;
    event: AuthLocationEvent;
    location?: LocationDto | null;
    ipAddress?: string;
    deviceId?: string;
  }): Promise<void> {
    const { location } = opts;
    if (!location || typeof location.latitude !== 'number' || typeof location.longitude !== 'number') {
      return;
    }
    try {
      let suspicious = false;
      if (opts.userId) {
        const last = await this.prisma.authLocationLog.findFirst({
          where: { userId: opts.userId },
          orderBy: { createdAt: 'desc' },
          select: { latitude: true, longitude: true, createdAt: true },
        });
        if (last) {
          const km = haversineKm(last.latitude, last.longitude, location.latitude, location.longitude);
          const hours = (Date.now() - last.createdAt.getTime()) / 3_600_000;
          if (km > 500 && hours < 2) {
            suspicious = true;
            this.logger.warn(
              `[AUTH-LOCATION] impossible-travel heuristic: user=${opts.userId} ` +
                `event=${opts.event} distance=${km.toFixed(0)}km in ${hours.toFixed(2)}h`,
            );
          }
        }
      }
      await this.prisma.authLocationLog.create({
        data: {
          userId: opts.userId ?? undefined,
          event: opts.event,
          latitude: location.latitude,
          longitude: location.longitude,
          accuracy: location.accuracy ?? undefined,
          ipAddress: opts.ipAddress ?? undefined,
          deviceId: opts.deviceId ?? undefined,
          suspicious,
        },
      });
    } catch (err) {
      this.logger.error(
        `[AUTH-LOCATION] failed to log event=${opts.event}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
