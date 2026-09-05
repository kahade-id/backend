import { GUARDS_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { NotificationsController } from '../notifications.controller';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';

describe('NotificationsController mutation throttling', () => {
  const TTL_KEY = 'THROTTLER:TTLdefault';
  const LIMIT_KEY = 'THROTTLER:LIMITdefault';

  function handlerOf(name: string): (...args: never[]) => unknown {
    const handler = (NotificationsController.prototype as unknown as Record<string, unknown>)[name];
    if (typeof handler !== 'function') throw new Error(`NotificationsController has no handler ${name}`);
    return handler as (...args: never[]) => unknown;
  }

  it('requires per-user throttling on authenticated notification mutations', () => {
    const routes = [
      'markAsRead',
      'markBatchAsRead',
      'deleteBatch',
      'markAllAsRead',
      'updatePreferences',
      'deleteNotification',
      'registerDevice',
      'unregisterDevice',
    ];

    for (const route of routes) {
      const handler = handlerOf(route);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBeDefined();
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(UserThrottleGuard);
      expect(Reflect.getMetadata(TTL_KEY, handler)).toBeGreaterThan(0);
      expect(Reflect.getMetadata(LIMIT_KEY, handler)).toBeGreaterThan(0);
    }
  });

  it('does not add the mutation guard to read-only notification routes', () => {
    for (const route of ['listNotifications', 'getUnreadCount', 'getPreferences']) {
      expect(Reflect.getMetadata(GUARDS_METADATA, handlerOf(route)) ?? []).not.toContain(UserThrottleGuard);
    }
  });
});
