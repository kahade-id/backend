import { SessionsController } from '../sessions.controller';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';

describe('SessionsController — pagination contract', () => {
  it('forwards page and limit query values to the service', async () => {
    const sessionsService = {
      getActiveSessions: jest.fn().mockResolvedValue({ sessions: [], total: 0, page: 2, limit: 10 }),
    };
    const controller = new SessionsController(sessionsService as never);

    await controller.getActiveSessions('user-1', 'session-1', 2, 10);

    expect(sessionsService.getActiveSessions).toHaveBeenCalledWith('user-1', 'session-1', 2, 10);
  });

  it('rate-limits active-session listing per authenticated user', () => {
    const handler = SessionsController.prototype.getActiveSessions;

    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60000);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(30);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(UserThrottleGuard);
  });
});
