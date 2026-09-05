import { PATH_METADATA } from '@nestjs/common/constants';
import { NotificationsController } from '../notifications.controller';

describe('NotificationsController route precedence', () => {
  it('declares static preferences before the dynamic notifId detail route', () => {
    const methods = Object.getOwnPropertyNames(NotificationsController.prototype);
    const preferencesIndex = methods.indexOf('getPreferences');
    const detailIndex = methods.indexOf('getNotification');

    expect(preferencesIndex).toBeGreaterThanOrEqual(0);
    expect(detailIndex).toBeGreaterThan(preferencesIndex);
    expect(Reflect.getMetadata(PATH_METADATA, NotificationsController.prototype.getPreferences)).toBe('preferences');
    expect(Reflect.getMetadata(PATH_METADATA, NotificationsController.prototype.getNotification)).toBe(':notifId');
  });
});
