import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { OrdersController } from '../orders.controller';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';
import { IDEMPOTENCY_KEY } from '../../../common/decorators/idempotency.decorator';

/*
 * C-26: three mutating POSTs shipped without any endpoint-level rate limit.
 *
 * `POST :orderId/delivery-proof/confirm` was the sharp one: it reaches the same
 * `OrderStateService.handleCompleteOrder` escrow release as `POST :orderId/complete`, which is
 * capped at 5 per 15 min plus a per-user sliding window. With neither decorator it fell through to
 * the 100/min `ThrottlerGuard` default, per-IP only — a 20x-looser alternate route to the same
 * money movement. `delivery-proof/reject` and `links/:token/cancel` had the same omission.
 *
 * These are structural assertions rather than three hardcoded ones so the invariant also covers
 * POSTs added later. `@Throttle` writes `THROTTLER:TTL<name>` / `THROTTLER:LIMIT<name>` onto the
 * handler function (`@nestjs/throttler@6.5.0` throttler.decorator.js), and `@UseGuards` writes
 * `__guards__` onto the same target, so both are readable without instantiating the module.
 */
describe('OrdersController — endpoint throttling (C-26)', () => {
  const THROTTLER_TTL_DEFAULT = 'THROTTLER:TTLdefault';
  const THROTTLER_LIMIT_DEFAULT = 'THROTTLER:LIMITdefault';

  type Handler = (...args: never[]) => unknown;

  function handlerOf(name: string): Handler {
    const proto = OrdersController.prototype as unknown as Record<string, Handler>;
    const fn = proto[name];
    if (typeof fn !== 'function') throw new Error(`OrdersController has no handler "${name}"`);
    return fn;
  }

  /** Every method on the controller that is mapped to an HTTP POST. */
  function postHandlerNames(): string[] {
    const proto = OrdersController.prototype as object;
    return Object.getOwnPropertyNames(proto)
      .filter((name) => name !== 'constructor')
      .filter((name) => {
        const descriptor = Object.getOwnPropertyDescriptor(proto, name);
        if (!descriptor || typeof descriptor.value !== 'function') return false;
        return Reflect.getMetadata(METHOD_METADATA, descriptor.value) === RequestMethod.POST;
      });
  }

  function throttleOf(name: string): { ttl?: number; limit?: number } {
    const fn = handlerOf(name);
    return {
      ttl: Reflect.getMetadata(THROTTLER_TTL_DEFAULT, fn) as number | undefined,
      limit: Reflect.getMetadata(THROTTLER_LIMIT_DEFAULT, fn) as number | undefined,
    };
  }

  function guardsOf(name: string): unknown[] {
    return (Reflect.getMetadata(GUARDS_METADATA, handlerOf(name)) as unknown[] | undefined) ?? [];
  }

  it('discovers the POST routes it is asserting over', () => {
    // Guards the reflection itself: if the metadata keys ever change, the invariant tests below
    // would vacuously pass over an empty list instead of failing.
    const names = postHandlerNames();
    expect(names.length).toBeGreaterThanOrEqual(14);
    expect(names).toEqual(expect.arrayContaining(['confirmDelivery', 'rejectDelivery', 'cancelOrderLink']));
  });

  it('gives every POST route an explicit @Throttle limit', () => {
    // Pre-fix: confirmDelivery, rejectDelivery and cancelOrderLink had no THROTTLER metadata at
    // all, so each reported { ttl: undefined, limit: undefined } and fell back to 100/min.
    const missing = postHandlerNames().filter((name) => {
      const { ttl, limit } = throttleOf(name);
      return ttl === undefined || limit === undefined;
    });
    expect(missing).toEqual([]);
  });

  it('puts every POST route behind the per-user throttle guard', () => {
    // `@Throttle` alone is tracked per-IP by the built-in ThrottlerGuard; UserThrottleGuard is what
    // makes the window per `user:sub`, so a shared NAT egress cannot be used to widen the limit.
    const missing = postHandlerNames().filter((name) => !guardsOf(name).includes(UserThrottleGuard));
    expect(missing).toEqual([]);
  });

  it('throttles delivery-proof confirmation exactly as strictly as direct completion', () => {
    // Both handlers reach OrderStateService.handleCompleteOrder. Asserting equality rather than
    // literals means the two cannot drift apart if the completion limit is ever retuned.
    expect(throttleOf('confirmDelivery')).toEqual(throttleOf('completeOrder'));
    // ...and pin the shape so a mutual relaxation to `undefined` still fails.
    expect(throttleOf('confirmDelivery')).toEqual({ ttl: 900000, limit: 5 });
  });

  it('throttles delivery rejection no more loosely than the escrow-releasing routes', () => {
    const reject = throttleOf('rejectDelivery');
    const complete = throttleOf('completeOrder');
    expect(reject.ttl).toBe(complete.ttl);
    // Rejection is repeatable where confirmation is terminal, so a looser limit is intended — but
    // it must stay bounded, not absent.
    expect(reject.limit).toBe(10);
  });

  it('caps order-link cancellation at the create-side ceiling', () => {
    // A creator cannot cancel more links than they created, so createOrderLink's limit is the
    // tightest bound that cannot reject a legitimate call.
    expect(throttleOf('cancelOrderLink')).toEqual(throttleOf('createOrderLink'));
  });

  it('marks every state-changing ORDER mutation as idempotent', () => {
    const criticalMutations = [
      'createOrder', 'confirmOrder', 'payOrder', 'processOrder', 'updateShipping', 'completeOrder', 'cancelOrder',
      'requestExtension', 'respondExtension', 'submitDispute', 'createOrderLink', 'acceptOrderLink', 'cancelOrderLink',
      'submitDeliveryProof', 'confirmDelivery', 'rejectDelivery',
    ];
    for (const name of criticalMutations) {
      expect(Reflect.getMetadata(IDEMPOTENCY_KEY, handlerOf(name))).toBe(true);
    }
  });
});
