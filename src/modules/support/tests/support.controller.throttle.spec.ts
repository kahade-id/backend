import { GUARDS_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { SupportController } from '../support.controller';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';

describe('SupportController mutation throttling', () => {
  const TTL_KEY = 'THROTTLER:TTLdefault';
  const LIMIT_KEY = 'THROTTLER:LIMITdefault';

  function handlerOf(name: string): (...args: never[]) => unknown {
    const handler = (SupportController.prototype as unknown as Record<string, unknown>)[name];
    if (typeof handler !== 'function') throw new Error(`SupportController has no handler ${name}`);
    return handler as (...args: never[]) => unknown;
  }

  it('requires per-user throttling on ticket creation and replies', () => {
    for (const route of ['createTicket', 'replyToTicket']) {
      const handler = handlerOf(route);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBeDefined();
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(UserThrottleGuard);
      expect(Reflect.getMetadata(TTL_KEY, handler)).toBeGreaterThan(0);
      expect(Reflect.getMetadata(LIMIT_KEY, handler)).toBeGreaterThan(0);
    }
  });

  it('does not add the mutation guard to ticket reads', () => {
    for (const route of ['getTickets', 'getTicketDetail']) {
      expect(Reflect.getMetadata(GUARDS_METADATA, handlerOf(route)) ?? []).not.toContain(UserThrottleGuard);
    }
  });
});
