import { isStoryUnexpired, storyAudienceAllows } from './story-visibility.util';

describe('Story visibility rules', () => {
  it('treats expiresAt as exclusive and fails closed for invalid dates', () => {
    const now = new Date('2026-10-08T12:00:00.000Z');
    expect(isStoryUnexpired(new Date('2026-10-08T12:00:00.001Z'), now)).toBe(true);
    expect(isStoryUnexpired(now, now)).toBe(false);
    expect(isStoryUnexpired('not-a-date', now)).toBe(false);
  });

  it('allows all profile savers for all_savers regardless of follow data', () => {
    expect(storyAudienceAllows({ mode: 'all_savers' }, 'USR-viewer')).toBe(true);
  });

  it('excludes only the selected public user IDs for savers_except', () => {
    const audience = { mode: 'savers_except', excludedUserIds: ['USR-hidden'] };
    expect(storyAudienceAllows(audience, 'USR-visible')).toBe(true);
    expect(storyAudienceAllows(audience, 'USR-hidden')).toBe(false);
    expect(storyAudienceAllows({ mode: 'unknown' }, 'USR-visible')).toBe(false);
    expect(storyAudienceAllows({ mode: 'savers_except' }, 'USR-visible')).toBe(false);
    expect(
      storyAudienceAllows({ mode: 'savers_except', excludedUserIds: ['USR-hidden', 7] }, 'USR-visible'),
    ).toBe(false);
  });
});
