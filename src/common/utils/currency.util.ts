/**
 * Convert IDR to Sen (IDR × 100).
 * String-based parsing avoids floating-point precision loss.
 * SEC-036: Overflow guard — rejects values outside safe range.
 */
export function toSen(idr: number): bigint {
  if (!Number.isFinite(idr)) {
    throw new RangeError(`toSen: input must be a finite number, got ${idr}`);
  }
  if (idr < 0) {
    throw new RangeError(`toSen: input must be non-negative, got ${idr}`);
  }
  if (idr > Number.MAX_SAFE_INTEGER / 100) {
    throw new RangeError(
      `toSen: input ${idr} exceeds safe integer range when converted to sen`,
    );
  }
  const [integer, decimal = ''] = idr.toFixed(2).split('.');
  return BigInt(integer) * 100n + BigInt(decimal.slice(0, 2).padEnd(2, '0'));
}

/**
 * Convert Sen to IDR as a number (preserving fractional rupiah for display).
 * Safe for values representable as a 53-bit integer (up to ~Rp 90 trillion).
 * Use only where the downstream API requires a JS number (e.g. Iris payout amount).
 * SEC-036: Overflow guard — rejects values exceeding MAX_SAFE_INTEGER.
 */
export function toIdr(sen: bigint): number {
  if (sen > BigInt(Number.MAX_SAFE_INTEGER) || sen < BigInt(-Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(
      `toIdr: input ${sen} exceeds Number.MAX_SAFE_INTEGER`,
    );
  }
  const whole = Number(sen / 100n);
  const frac = Number(sen % 100n);
  return whole + frac / 100;
}

/**
 * Format IDR to currency string. Example: 100000 -> "Rp 100.000"
 */
export function formatIdr(amount: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * Format Sen (BigInt) directly to IDR currency string.
 * Example: 10000000n -> "Rp 100.000"
 */
export function formatSen(sen: bigint): string {
  return formatIdr(toIdr(sen));
}

/**
 * Convert a percent value (e.g. 2.5 = 2.5%) to integer basis points as BigInt — EXACT.
 *
 * WF-004: string-based conversion avoids binary float error
 * (Number(2.675) * 100 = 267.4999… → Math.round gives 267 instead of 268).
 * Accepts Prisma.Decimal (via toFixed), string, or number.
 * Rounds half-up to the nearest basis point.
 */
export function percentToBpsBigInt(
  pct: string | number | { toFixed(digits: number): string },
): bigint {
  let s: string;
  if (typeof pct === 'number') {
    if (!Number.isFinite(pct) || pct < 0) {
      throw new RangeError(`percentToBpsBigInt: input must be a finite non-negative number, got ${pct}`);
    }
    s = pct.toFixed(6);
  } else if (typeof pct === 'string') {
    s = pct.trim();
  } else {
    s = pct.toFixed(6);
  }
  if (s.startsWith('-')) {
    throw new RangeError(`percentToBpsBigInt: negative percent not allowed: ${s}`);
  }
  if (!/[0-9]/.test(s)) {
    throw new RangeError(`percentToBpsBigInt: cannot parse percent value: ${s}`);
  }
  const [intPartRaw, fracPartRaw = ''] = s.split('.');
  const intPart = intPartRaw.replace(/[^0-9]/g, '') || '0';
  const frac = (fracPartRaw.replace(/[^0-9]/g, '') + '000000').slice(0, 6);
  // bps = percent × 100, computed at 1e6 scale then rounded half-up.
  const scaled = BigInt(intPart) * 100n * 1_000_000n + BigInt(frac) * 100n;
  return (scaled + 500_000n) / 1_000_000n;
}
