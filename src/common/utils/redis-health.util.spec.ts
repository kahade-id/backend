import * as Sentry from '@sentry/nestjs';
import {
  alertMoneyCronSkippedRedisDown,
  ensureRedisAvailable,
} from './redis-health.util';

jest.mock('@sentry/nestjs', () => ({
  withScope: jest.fn((cb: (scope: unknown) => void) =>
    cb({ setTag: jest.fn(), setExtra: jest.fn() }),
  ),
  captureMessage: jest.fn(),
}));

describe('ensureRedisAvailable (CW-014)', () => {
  const makeRedis = (healthy: boolean) => ({
    isHealthy: jest.fn().mockResolvedValue(healthy),
  });

  it('returns true and does not fire onRedisDown when Redis is healthy', async () => {
    const onRedisDown = jest.fn();
    const ok = await ensureRedisAvailable(makeRedis(true) as never, 'auto-complete-orders', {
      onRedisDown,
    });
    expect(ok).toBe(true);
    expect(onRedisDown).not.toHaveBeenCalled();
  });

  it('returns false and fires onRedisDown when Redis is down', async () => {
    const onRedisDown = jest.fn();
    const ok = await ensureRedisAvailable(makeRedis(false) as never, 'withdrawal-reconciliation', {
      onRedisDown,
    });
    expect(ok).toBe(false);
    expect(onRedisDown).toHaveBeenCalledTimes(1);
  });

  it('still returns false when onRedisDown itself throws', async () => {
    const ok = await ensureRedisAvailable(makeRedis(false) as never, 'pending-topup-cleanup', {
      onRedisDown: () => {
        throw new Error('boom');
      },
    });
    expect(ok).toBe(false);
  });

  it('alertMoneyCronSkippedRedisDown emits a Sentry event naming the job (no PII)', () => {
    alertMoneyCronSkippedRedisDown('auto-complete-orders');
    expect(Sentry.withScope).toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('auto-complete-orders'),
      'error',
    );
  });
});
