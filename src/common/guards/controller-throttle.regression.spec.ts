import { GUARDS_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { ChatController } from '../../modules/chat/chat.controller';
import { RatingsController } from '../../modules/ratings/ratings.controller';
import { ReferralController } from '../../modules/referral/referral.controller';
import { TransactionTemplatesController } from '../../modules/transaction-templates/transaction-templates.controller';
import { UploadController } from '../../modules/upload/upload.controller';
import { VouchersController } from '../../modules/vouchers/vouchers.controller';
import { AdminBadgesController } from '../../modules/admin/badges/admin-badges.controller';
import { AdminCampaignsController } from '../../modules/admin/campaigns/admin-campaigns.controller';
import { AdminRatingsController } from '../../modules/admin/ratings/admin-ratings.controller';
import { AdminReportsController } from '../../modules/admin/reports/admin-reports.controller';
import { AdminSupportController } from '../../modules/admin/support/admin-support.controller';
import { UserThrottleGuard } from './user-throttle.guard';

type ControllerClass = { prototype: object };

function handlerOf(controller: ControllerClass, name: string): (...args: never[]) => unknown {
  const handler = (controller.prototype as Record<string, unknown>)[name];
  if (typeof handler !== 'function') throw new Error(`Missing controller handler ${name}`);
  return handler as (...args: never[]) => unknown;
}

describe('non-order controller throttle regression', () => {
  it('protects user-owned chat, rating, referral, template, upload, and voucher mutations', () => {
    const routes: Array<[ControllerClass, string[]]> = [
      [ChatController, ['sendMessage', 'markAsRead', 'deleteMessage', 'uploadChatFile']],
      [RatingsController, ['createRating', 'updateRating', 'replyToRating', 'updateReply', 'deleteReply']],
      [ReferralController, ['applyCode', 'regenerateCode']],
      [TransactionTemplatesController, ['createTemplate', 'updateTemplate', 'deleteTemplate']],
      [UploadController, ['getPresignedUrl', 'confirmUpload', 'uploadDirect', 'cleanupFiles']],
      [VouchersController, ['validateVoucher']],
    ];

    for (const [controller, names] of routes) {
      for (const name of names) {
        const handler = handlerOf(controller, name);
        expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBeDefined();
        expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(UserThrottleGuard);
      }
    }
  });

  it('protects non-order admin mutations with the admin identity tracker', () => {
    const routes: Array<[ControllerClass, string[]]> = [
      [AdminBadgesController, ['createBadge', 'updateBadge', 'deleteBadge', 'awardBadge', 'revokeBadge']],
      [AdminCampaignsController, ['createCampaign', 'updateCampaign', 'deleteCampaign']],
      [AdminRatingsController, ['removeRating', 'unhideRating']],
      [AdminReportsController, ['resolveReport', 'dismissReport']],
      [AdminSupportController, ['reply', 'updateStatus']],
    ];

    for (const [controller, names] of routes) {
      for (const name of names) {
        const handler = handlerOf(controller, name);
        expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBeDefined();
        expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(UserThrottleGuard);
      }
    }
  });
});
