import { GUARDS_METADATA } from '@nestjs/common/constants';
import { UsersController } from '../users.controller';
import { KycRequiredGuard } from '../../../common/guards/kyc-required.guard';

describe('UsersController — account deletion policy', () => {
  it('does not put account deletion behind the KYC guard', () => {
    const handler = UsersController.prototype.requestAccountDeletion;
    const guards = (Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined) ?? [];
    expect(guards).not.toContain(KycRequiredGuard);
  });
});
