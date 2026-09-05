import { WithdrawalsController } from '../withdrawals.controller';
import { IDEMPOTENCY_KEY } from '../../../common/decorators/idempotency.decorator';

describe('WithdrawalsController — idempotency contract', () => {
  const handlers = ['createSchedule', 'updateSchedule', 'deleteSchedule'] as const;

  it('marks every scheduled-withdrawal mutation as idempotent for network retries', () => {
    for (const name of handlers) {
      expect(Reflect.getMetadata(IDEMPOTENCY_KEY, WithdrawalsController.prototype[name])).toBe(true);
    }
  });
});
