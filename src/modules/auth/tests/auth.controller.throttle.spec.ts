import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthController } from '../auth.controller';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';

type Handler = (...args: never[]) => unknown;

function handlerOf(name: string): Handler {
  const handler = (AuthController.prototype as unknown as Record<string, Handler>)[name];
  if (typeof handler !== 'function') throw new Error(`AuthController has no handler ${name}`);
  return handler;
}

describe('AuthController per-user throttling', () => {
  it('throttles authenticated identity and session mutations', () => {
    for (const route of ['getCsrfToken', 'setUsername', 'correctEmail', 'logout', 'verifyPassword', 'changePassword']) {
      expect(Reflect.getMetadata(GUARDS_METADATA, handlerOf(route))).toContain(UserThrottleGuard);
    }
  });

  it('throttles every 2FA lifecycle mutation', () => {
    for (const route of ['setup2fa', 'enable2fa', 'requestDisable2faOtp', 'disable2fa', 'regenerateBackupCodes']) {
      expect(Reflect.getMetadata(GUARDS_METADATA, handlerOf(route))).toContain(UserThrottleGuard);
    }
  });
});
