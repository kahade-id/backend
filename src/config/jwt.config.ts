import { registerAs } from '@nestjs/config';

const MAX_ADMIN_TTL_SECONDS = 2 * 60 * 60;

function parseTtlToSeconds(ttl: string): number {
  const match = ttl.match(/^(\d+)([smhd])$/);
  if (!match) return 30 * 60;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case 's': return value;
    case 'm': return value * 60;
    case 'h': return value * 3600;
    case 'd': return value * 86400;
    default: return 30 * 60;
  }
}

function clampAdminTtl(ttl: string): string {
  const match = ttl.match(/^(\d+)([smhd])$/);
  if (!match) {
    return '30m';
  }
  const seconds = parseTtlToSeconds(ttl);
  if (seconds > MAX_ADMIN_TTL_SECONDS) {
    return '2h';
  }
  return ttl;
}

// under the 'crypto' namespace. This file now contains only JWT-related configuration.
export const jwtConfig = registerAs('jwt', () => {
  const secret = process.env.JWT_SECRET ?? '';
  const refreshSecret = process.env.JWT_REFRESH_SECRET ?? '';
  const adminSecret = process.env.JWT_ADMIN_SECRET ?? '';
  const adminRefreshSecret = process.env.JWT_ADMIN_REFRESH_SECRET ?? '';
  const tempSecret = process.env.JWT_TEMP_SECRET ?? '';

  const nodeEnv = process.env.NODE_ENV || 'development';
  if (['production', 'staging'].includes(nodeEnv)) {
    const missing = [
      !secret && 'JWT_SECRET',
      !refreshSecret && 'JWT_REFRESH_SECRET',
      !adminSecret && 'JWT_ADMIN_SECRET',
      !adminRefreshSecret && 'JWT_ADMIN_REFRESH_SECRET',
      !tempSecret && 'JWT_TEMP_SECRET',
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(`Missing required JWT secrets in ${nodeEnv}: ${missing.join(', ')}`);
    }
  }

  return {
    secret,
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
    refreshSecret,
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
    adminSecret,
    adminExpiresIn: clampAdminTtl(process.env.JWT_ADMIN_EXPIRES_IN || '30m'),
    adminRefreshSecret,
    adminRefreshExpiresIn: process.env.JWT_ADMIN_REFRESH_EXPIRES_IN || '7d',
    tempExpiresIn: process.env.JWT_TEMP_EXPIRES_IN || '5m',
    tempSecret,
  };
});
