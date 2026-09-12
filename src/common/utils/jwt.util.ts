const MULTIPLIERS: Record<string, number> = {
  s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
  m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
  d: 86400, day: 86400, days: 86400,
  w: 604800, week: 604800, weeks: 604800,
};
const DEFAULT_TTL_SECONDS = 15 * 60;

/**
 * R2-I (audit): @nestjs/jwt feeds `expiresIn` to the `ms` package, which accepts
 * spaced and word forms ("2 days", "90 mins"). The compact-only regex previously
 * fell back to DEFAULT_TTL_SECONDS for those operator-approved configs, so
 * revocation markers (blacklist/session TTL) expired long before the tokens they
 * guarded — a revoked user could ride the still-valid token after the marker was
 * gone. The parser now covers every human form the token library itself accepts.
 */
export function parseJwtTtl(expiresIn: string): number {
  const match = (expiresIn ?? '').trim().toLowerCase().match(/^(\d+)\s*([a-z]+)$/);
  if (!match || !Number.isSafeInteger(parseInt(match[1], 10))) return DEFAULT_TTL_SECONDS;
  const multiplier = MULTIPLIERS[match[2]];
  if (!multiplier) return DEFAULT_TTL_SECONDS;
  return Math.max(1, Math.min(parseInt(match[1], 10) * multiplier, 30 * 24 * 3600));
}
