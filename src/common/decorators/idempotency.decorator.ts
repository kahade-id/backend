import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENCY_KEY = 'idempotency';
export const Idempotency = (): ReturnType<typeof SetMetadata> => SetMetadata(IDEMPOTENCY_KEY, true);
