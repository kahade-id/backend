import { Logger } from '@nestjs/common';
import { parseStrictBoolean, parseStrictInteger, safeErrorMessage, startLockRenewal, withTimeout } from './background-reliability.util';

describe('background reliability utilities', () => {
  it('times out a stalled operation and clears its timer', async () => {
    await expect(withTimeout(new Promise(() => undefined), 5, 'probe')).rejects.toThrow('probe timed out after 5ms');
  });

  it('rejects permissive integer parsing inputs', () => {
    expect(parseStrictInteger('10foo', 25, 1, 100)).toBe(25);
    expect(parseStrictInteger('1.5', 25, 1, 100)).toBe(25);
    expect(parseStrictInteger('10', 25, 1, 100)).toBe(10);
    expect(parseStrictBoolean('TRUE')).toBe(true);
    expect(parseStrictBoolean('false')).toBe(false);
    expect(parseStrictBoolean('yes', true)).toBe(true);
  });

  it('sanitizes control characters and bounds error text', () => {
    expect(safeErrorMessage(new Error('a\n\u0000b'))).toBe('a  b');
    expect(safeErrorMessage('x'.repeat(10), 3)).toBe('xxx');
  });

  it('marks a lease lost after token-aware renewal fails', async () => {
    jest.useFakeTimers();
    const renewLock = jest.fn().mockResolvedValue(false);
    const logger = { error: jest.fn() } as unknown as Logger;
    const handle = startLockRenewal({ renewLock } as never, 'lock', 'token', 3, logger);

    jest.advanceTimersByTime(1_000);
    await Promise.resolve();
    expect(renewLock).toHaveBeenCalledWith('lock', 'token', 3);
    expect(handle.lost()).toBe(true);
    expect(logger.error).toHaveBeenCalled();
    handle.stop();
    jest.useRealTimers();
  });
});
