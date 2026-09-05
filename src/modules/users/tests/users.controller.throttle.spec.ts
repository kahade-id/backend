import { METHOD_METADATA } from '@nestjs/common/constants';
import { UsersController } from '../users.controller';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';

describe('UsersController device security throttling', () => {
  const TTL_KEY = 'THROTTLER:TTLdefault';
  const LIMIT_KEY = 'THROTTLER:LIMITdefault';

  function handlerOf(name: string): (...args: never[]) => unknown {
    const handler = (UsersController.prototype as unknown as Record<string, unknown>)[name];
    if (typeof handler !== 'function') throw new Error(`UsersController has no handler ${name}`);
    return handler as (...args: never[]) => unknown;
  }

  it('keeps device security and security-log routes explicit and rate-limited', () => {
    const routes = ['getMyDevices', 'getSecurityLog', 'removeDevice', 'trustDevice', 'untrustDevice'];
    for (const route of routes) {
      const handler = handlerOf(route);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBeDefined();
      expect(Reflect.getMetadata(TTL_KEY, handler)).toBeGreaterThan(0);
      expect(Reflect.getMetadata(LIMIT_KEY, handler)).toBeGreaterThan(0);
    }
  });

  it('uses a stricter window for password-gated trust changes than device removal', () => {
    const remove = handlerOf('removeDevice');
    const trust = handlerOf('trustDevice');
    const untrust = handlerOf('untrustDevice');
    expect(Reflect.getMetadata(TTL_KEY, trust)).toBe(900000);
    expect(Reflect.getMetadata(LIMIT_KEY, trust)).toBe(10);
    expect(Reflect.getMetadata(TTL_KEY, untrust)).toBe(900000);
    expect(Reflect.getMetadata(LIMIT_KEY, untrust)).toBe(10);
    expect(Reflect.getMetadata(TTL_KEY, remove)).toBe(60000);
    expect(Reflect.getMetadata(LIMIT_KEY, remove)).toBe(20);
  });

  it('requires per-user throttling on authenticated account and social mutations', () => {
    const routes = [
      'updateProfile', 'uploadAvatar', 'confirmAvatar', 'uploadAvatarDirect', 'deleteAvatar',
      'uploadHeader', 'confirmHeader', 'uploadHeaderDirect', 'deleteHeader', 'updateLinks',
      'requestAccountDeletion', 'getMyDevices', 'getSecurityLog', 'removeDevice', 'trustDevice', 'untrustDevice',
      'uploadShowcaseImage', 'createShowcaseItem', 'updateShowcaseItem', 'deleteShowcaseItem',
      'addFavorite', 'removeFavorite', 'blockUser', 'unblockUser', 'reportUser',
      'followUser', 'unfollowUser', 'askQuestion', 'answerQuestion', 'deleteQuestion',
      'addComment', 'deleteComment',
    ];
    for (const route of routes) {
      expect(Reflect.getMetadata(GUARDS_METADATA, handlerOf(route))).toContain(UserThrottleGuard);
    }
  });

  it('rate-limits authenticated favorite and saved-profile reads per user', () => {
    const routes = ['getFavorites', 'getSavedProfiles', 'checkFavorite', 'checkSavedProfile'];
    for (const route of routes) {
      const handler = handlerOf(route);
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(UserThrottleGuard);
      expect(Reflect.getMetadata(TTL_KEY, handler)).toBe(60000);
      expect(Reflect.getMetadata(LIMIT_KEY, handler)).toBe(30);
    }
  });

  it('does not accidentally classify these routes as public', () => {
    for (const route of ['getMyDevices', 'getSecurityLog', 'removeDevice', 'trustDevice', 'untrustDevice']) {
      expect(Reflect.getMetadata('isPublic', handlerOf(route))).not.toBe(true);
    }
  });
});
