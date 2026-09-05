import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { AuditLogService, AUDIT_LOG_QUEUE } from './audit-log.service';
import { AuditLogProcessor } from '../../modules/queue/processors/audit-log.processor';
import { DEAD_LETTER_QUEUE } from '../../modules/queue/queue.constants';

@Module({
  imports: [
    BullModule.registerQueue(
      {
        name: AUDIT_LOG_QUEUE,
        settings: { stalledInterval: 30_000, maxStalledCount: 1 },
        defaultJobOptions: {
          attempts: 3,
          timeout: 120_000,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: 100,
          removeOnFail: false,
        },
      },
      { name: DEAD_LETTER_QUEUE, settings: { stalledInterval: 60_000, maxStalledCount: 1 } },
    ),
  ],
  providers: [AuditLogService, AuditLogProcessor],
  exports: [AuditLogService],
})
export class AuditLogModule {}
