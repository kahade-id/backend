import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { AdminOrdersController } from '../orders/admin-orders.controller';
import { AdminDisputesController } from '../disputes/admin-disputes.controller';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';
import { IDEMPOTENCY_KEY } from '../../../common/decorators/idempotency.decorator';

type Handler = (...args: never[]) => unknown;

function postHandlerNames(controller: object): string[] {
  const proto = controller as object;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor')
    .filter((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      return Boolean(descriptor && typeof descriptor.value === 'function' && Reflect.getMetadata(METHOD_METADATA, descriptor.value) === RequestMethod.POST);
    });
}

function handlerOf(controller: object, name: string): Handler {
  const fn = (controller as unknown as Record<string, Handler>)[name];
  if (typeof fn !== 'function') throw new Error(`Missing handler ${name}`);
  return fn;
}

function guardsOf(controller: object, name: string): unknown[] {
  return (Reflect.getMetadata(GUARDS_METADATA, handlerOf(controller, name)) as unknown[] | undefined) ?? [];
}

describe('Admin escrow mutation contracts', () => {
  it('discovers all admin ORDER POST mutations', () => {
    expect(postHandlerNames(AdminOrdersController.prototype)).toEqual(
      expect.arrayContaining(['forceCancel', 'forceComplete']),
    );
  });

  it('requires idempotency and per-user throttling on every admin ORDER mutation', () => {
    const names = postHandlerNames(AdminOrdersController.prototype);
    expect(names.length).toBe(2);
    for (const name of names) {
      const handler = handlerOf(AdminOrdersController.prototype, name);
      expect(Reflect.getMetadata(IDEMPOTENCY_KEY, handler)).toBe(true);
      expect(guardsOf(AdminOrdersController.prototype, name)).toContain(UserThrottleGuard);
    }
  });

  it('requires idempotency and per-user throttling on every admin dispute mutation', () => {
    const names = postHandlerNames(AdminDisputesController.prototype);
    expect(names).toEqual(expect.arrayContaining(['sendDisputeMessage', 'assignAdmin', 'markUnderReview', 'resolve']));
    expect(names.length).toBe(4);
    for (const name of names) {
      const handler = handlerOf(AdminDisputesController.prototype, name);
      expect(Reflect.getMetadata(IDEMPOTENCY_KEY, handler)).toBe(true);
      expect(guardsOf(AdminDisputesController.prototype, name)).toContain(UserThrottleGuard);
    }
  });
});
