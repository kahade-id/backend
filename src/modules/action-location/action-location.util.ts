import type { Request } from 'express';
import type { LocationDto } from '../auth/dto/location.dto';
import type { ActionLocationContext } from './action-location.service';

/**
 * Bangun ActionLocationContext dari request + DTO aksi sensitif.
 * - location: dari `deviceLocation` di body (null/absent = user menolak GPS).
 * - ipAddress: pola standar `req.ip || req.socket?.remoteAddress || 'unknown'`.
 * - deviceId: header `X-Device-Id` bila dikirim client (opsional).
 */
export function extractLocationContext(
  req: Request,
  dto?: { deviceLocation?: LocationDto | null },
): ActionLocationContext {
  const ipAddress = req.ip || req.socket?.remoteAddress || 'unknown';
  const deviceIdHeader = req.headers['x-device-id'];
  const deviceId =
    typeof deviceIdHeader === 'string' && deviceIdHeader.length > 0 ? deviceIdHeader : undefined;
  return {
    location: dto?.deviceLocation ?? null,
    ipAddress,
    deviceId,
  };
}
