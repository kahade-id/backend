import 'reflect-metadata';
import { IDEMPOTENCY_KEY } from '../../../../common/decorators/idempotency.decorator';
import { AdminSystemController } from '../admin-system.controller';

describe('AdminSystemController mutation contracts', () => {
  it.each(['updateConfig', 'approveConfigChange', 'rejectConfigChange', 'sendBroadcast'])(
    '%s requires idempotency',
    (method) => {
      expect(Reflect.getMetadata(IDEMPOTENCY_KEY, AdminSystemController.prototype[method as keyof AdminSystemController],)).toBe(true);
    },
  );
});
