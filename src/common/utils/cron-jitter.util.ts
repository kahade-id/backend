import { randomInt } from 'crypto';

/**
 * Adds CSPRNG-based jitter (0..maxMs) before scheduler tick body executes.
 * Prevents thundering-herd when multiple replicas run the same @Cron at the same second.
 */
export function cronJitter(maxMs = 5_000): Promise<void> {
  const delay = randomInt(0, Math.max(1, maxMs));
  return new Promise((resolve) => setTimeout(resolve, delay));
}
