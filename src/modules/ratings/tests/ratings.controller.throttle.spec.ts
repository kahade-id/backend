import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RatingsController } from '../ratings.controller';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';

describe('RatingsController throttling', () => {
  it('uses the per-user throttle on private rating history', () => {
    const handler = RatingsController.prototype.getMyRatings;

    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(UserThrottleGuard);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60000);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(30);
  });
});
