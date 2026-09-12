import { METHOD_METADATA, GUARDS_METADATA } from '@nestjs/common/constants';
import { ShowcaseController } from '../showcase.controller';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';

/**
 * Section 3 — guard/throttle metadata untuk permukaan sosial showcase.
 *
 * Mengikuti pola `users.controller.throttle.spec.ts`: metadata dibaca langsung
 * dari handler (tanpa booting app) supaya regresi rate-limit terdeteksi walau
 * tidak ada server yang jalan.
 */
describe('ShowcaseController throttling and visibility metadata', () => {
  const TTL_KEY = 'THROTTLER:TTLdefault';
  const LIMIT_KEY = 'THROTTLER:LIMITdefault';

  function handlerOf(name: string): (...args: never[]) => unknown {
    const handler = (ShowcaseController.prototype as unknown as Record<string, unknown>)[name];
    if (typeof handler !== 'function') throw new Error(`ShowcaseController has no handler ${name}`);
    return handler as (...args: never[]) => unknown;
  }

  const isPublic = (name: string): boolean =>
    Reflect.getMetadata(IS_PUBLIC_KEY, handlerOf(name)) === true;

  describe('read endpoints', () => {
    it('exposes the feed, item detail, comments and share payload publicly', () => {
      for (const route of ['getFeed', 'getShowcase', 'listComments', 'getSharePayload']) {
        expect(isPublic(route)).toBe(true);
      }
    });

    it('rate-limits public reads per window', () => {
      for (const route of ['getFeed', 'getShowcase', 'listComments', 'getSharePayload']) {
        expect(Reflect.getMetadata(METHOD_METADATA, handlerOf(route))).toBeDefined();
        expect(Reflect.getMetadata(TTL_KEY, handlerOf(route))).toBe(60000);
        expect(Reflect.getMetadata(LIMIT_KEY, handlerOf(route))).toBe(60);
      }
    });
  });

  describe('write endpoints', () => {
    const mutations = ['likeShowcase', 'unlikeShowcase', 'addComment', 'updateComment', 'deleteComment', 'hideComment', 'unhideComment'];

    it('requires authentication (never marked @Public)', () => {
      for (const route of mutations) {
        expect(isPublic(route)).toBe(false);
        expect(Reflect.getMetadata(IS_PUBLIC_KEY, handlerOf(route))).toBeUndefined();
      }
    });

    it('applies per-user throttling to every like and comment mutation', () => {
      for (const route of mutations) {
        expect(Reflect.getMetadata(GUARDS_METADATA, handlerOf(route))).toContain(UserThrottleGuard);
      }
    });

    it('rate-limits like mutations at 30/min and comment mutations at 20/min', () => {
      for (const route of ['likeShowcase', 'unlikeShowcase']) {
        expect(Reflect.getMetadata(TTL_KEY, handlerOf(route))).toBe(60000);
        expect(Reflect.getMetadata(LIMIT_KEY, handlerOf(route))).toBe(30);
      }
      for (const route of ['addComment', 'updateComment', 'deleteComment', 'hideComment', 'unhideComment']) {
        expect(Reflect.getMetadata(TTL_KEY, handlerOf(route))).toBe(60000);
        expect(Reflect.getMetadata(LIMIT_KEY, handlerOf(route))).toBe(20);
      }
    });
  });

  describe('route ordering', () => {
    // Path statis harus dideklarasikan sebelum ':showcaseId', kalau tidak
    // "feed" dan "comments/:id" akan ditangkap sebagai id showcase. Urutan
    // properti prototype == urutan deklarasi method di class.
    const declared = Object.getOwnPropertyNames(ShowcaseController.prototype);
    const positionOf = (name: string) => {
      expect(declared).toContain(name);
      return declared.indexOf(name);
    };

    it('declares the feed before the parameterized showcase route', () => {
      expect(positionOf('getFeed')).toBeLessThan(positionOf('getShowcase'));
    });

    it('declares comment moderation routes before the parameterized showcase route', () => {
      for (const route of ['updateComment', 'deleteComment', 'hideComment', 'unhideComment']) {
        expect(positionOf(route)).toBeLessThan(positionOf('getShowcase'));
      }
    });

    it('declares the item sub-routes before the bare item route', () => {
      for (const route of ['getSharePayload', 'listComments', 'addComment', 'likeShowcase', 'unlikeShowcase']) {
        expect(positionOf(route)).toBeLessThan(positionOf('getShowcase'));
      }
    });

    it('keeps the documented route paths', () => {
      expect(Reflect.getMetadata('path', handlerOf('getFeed'))).toBe('feed');
      expect(Reflect.getMetadata('path', handlerOf('getShowcase'))).toBe(':showcaseId');
      expect(Reflect.getMetadata('path', handlerOf('updateComment'))).toBe('comments/:commentId');
      expect(Reflect.getMetadata('path', handlerOf('getSharePayload'))).toBe(':showcaseId/share');
      expect(Reflect.getMetadata('path', handlerOf('likeShowcase'))).toBe(':showcaseId/like');
    });
  });
});
