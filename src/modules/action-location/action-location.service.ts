import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { ActionLocationType } from '@prisma/client';
import type { LocationDto } from '../auth/dto/location.dto';

/**
 * Konteks lokasi yang diteruskan controller → service untuk tiap aksi sensitif.
 * Selalu opsional: null/absent = user menolak GPS (frontend memang mengirim
 * shape LocationDto atau tidak mengirim field ini sama sekali).
 */
export interface ActionLocationContext {
  location?: LocationDto | null;
  ipAddress?: string;
  deviceId?: string;
}

/**
 * Mencatat lokasi presisi pada aksi sensitif non-auth
 * (order, wallet, dispute, hapus akun).
 * - Selalu best-effort: kegagalan tulis log TIDAK boleh menggagalkan aksi.
 * - Bila location null/absent → tulis row dengan locationDenied=true
 *   (koordinat NULL), aksi tetap berjalan normal.
 * - Heuristik impossible-travel: bila log terakhir user yang sama berjarak
 *   > 500 km dalam < 2 jam, tandai suspicious=true (murni penanda review,
 *   tidak memblokir).
 * - Aksi auth (login/register/otp/phone_change/password_reset/password_change)
 *   TIDAK dicatat di sini — sudah dicakup AuthLocationService agar tidak
 *   double-log.
 */
@Injectable()
export class ActionLocationService {
  private readonly logger = new Logger(ActionLocationService.name);

  constructor(@Optional() private readonly prisma?: PrismaService) {}

  async logAction(opts: {
    userId: string;
    actionType: ActionLocationType;
    referenceType?: string;
    referenceId?: string;
    location?: LocationDto | null;
    ipAddress?: string;
    deviceId?: string;
  }): Promise<void> {
    const { userId, actionType, location } = opts;
    if (!userId || !this.prisma) return;
    try {
      const denied = !location || typeof location.latitude !== 'number' || typeof location.longitude !== 'number';
      let suspicious = false;
      if (!denied) {
        const last = await this.prisma.actionLocation.findFirst({
          where: { userId, latitude: { not: null }, longitude: { not: null } },
          orderBy: { createdAt: 'desc' },
          select: { latitude: true, longitude: true, createdAt: true },
        });
        if (last?.latitude != null && last?.longitude != null) {
          const km = haversineKm(last.latitude, last.longitude, location!.latitude, location!.longitude);
          const hours = (Date.now() - last.createdAt.getTime()) / 3_600_000;
          if (km > 500 && hours < 2) {
            suspicious = true;
            this.logger.warn(
              `[ACTION-LOCATION] impossible-travel heuristic: user=${userId} ` +
                `action=${actionType} distance=${km.toFixed(0)}km in ${hours.toFixed(2)}h`,
            );
          }
        }
      }
      await this.prisma.actionLocation.create({
        data: {
          userId,
          actionType,
          referenceType: opts.referenceType ?? undefined,
          referenceId: opts.referenceId ?? undefined,
          latitude: denied ? undefined : location!.latitude,
          longitude: denied ? undefined : location!.longitude,
          accuracy: denied ? undefined : location!.accuracy ?? undefined,
          source: denied ? undefined : location!.source ?? undefined,
          locationDenied: denied,
          ipAddress: opts.ipAddress ?? undefined,
          deviceId: opts.deviceId ?? undefined,
          suspicious,
        },
      });
    } catch (err) {
      this.logger.error(
        `[ACTION-LOCATION] failed to log action=${actionType}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// Haversine — disalin dari auth-location.service.ts (sumber) agar modul ini
// tidak bergantung ke AuthLocationService; ambang 500 km / 2 jam disamakan
// dengan heuristik auth agar penanda `suspicious` konsisten lintas tabel.
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
