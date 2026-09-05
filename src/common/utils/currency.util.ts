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
