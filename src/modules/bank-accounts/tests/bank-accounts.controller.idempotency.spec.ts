import { BankAccountsController } from '../bank-accounts.controller';
import { IDEMPOTENCY_KEY } from '../../../common/decorators/idempotency.decorator';

describe('BankAccountsController — idempotency contract', () => {
  const handlers = ['add', 'setPrimary', 'delete'] as const;

  it('marks every bank-account mutation as idempotent for retry-safe payout destination changes', () => {
    for (const name of handlers) {
      expect(Reflect.getMetadata(IDEMPOTENCY_KEY, BankAccountsController.prototype[name])).toBe(true);
    }
  });
});
