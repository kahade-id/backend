const MULTIPLIERS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
const DEFAULT_TTL_SECONDS = 15 * 60;

export function parseJwtTtl(expiresIn: string): number {
  const match = expiresIn.match(/^(\d+)([smhdw])$/);
  if (!match) return DEFAULT_TTL_SECONDS;
  const value = parseInt(match[1], 10);
  return value * (MULTIPLIERS[match[2]] ?? 60);
}
