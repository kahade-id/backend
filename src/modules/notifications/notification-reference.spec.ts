import {
  assertValidNotificationReference,
  type NotificationReference,
} from './notification-reference';

describe('NotificationReference contract (SYS-C-402)', () => {
  it('menerima refType + refId entitas yang valid', () => {
    const ref: NotificationReference = { refType: 'ShowcaseReport', refId: 'rep_123' };
    expect(() => assertValidNotificationReference(ref)).not.toThrow();
  });

  it('menolak refType kosong', () => {
    expect(() =>
      assertValidNotificationReference({ refType: '  ', refId: 'rep_123' }),
    ).toThrow('NOTIFICATION_REF_INVALID');
  });

  it('menolak refId kosong', () => {
    expect(() =>
      assertValidNotificationReference({ refType: 'ShowcaseReport', refId: '' }),
    ).toThrow('NOTIFICATION_REF_INVALID');
  });

  it('menolak ref bukan objek', () => {
    expect(() =>
      assertValidNotificationReference(undefined as unknown as NotificationReference),
    ).toThrow('NOTIFICATION_REF_INVALID');
  });

  it('refId entitas (bukan userId) lolos — semantik dikunci di sini', () => {
    // Kontrak: refId = id entitas yang dirujuk. Test ini mengunci bahwa
    // validator tidak mengasumsikan format userId apa pun.
    const ref: NotificationReference = { refType: 'UserShowcase', refId: 'showcase_abc' };
    expect(() => assertValidNotificationReference(ref)).not.toThrow();
  });
});
