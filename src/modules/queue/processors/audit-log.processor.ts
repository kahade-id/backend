import { Process, Processor, OnQueueFailed } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bull';
import { InjectQueue } from '@nestjs/bull';
import { AuditLogService, AUDIT_LOG_QUEUE, AuditLogJobData } from '../../../common/services/audit-log.service';
import { DEAD_LETTER_QUEUE, deadLetterJobId } from '../queue.constants';
import { safeErrorMessage } from '../../../common/utils/background-reliability.util';

@Processor(AUDIT_LOG_QUEUE)
export class AuditLogProcessor {
  private readonly logger = new Logger(AuditLogProcessor.name);

  constructor(
    private readonly auditLogService: AuditLogService,
    @InjectQueue(DEAD_LETTER_QUEUE) private readonly deadLetterQueue: Queue,
  ) {}

  @Process('write')
  async handleWrite(job: Job<AuditLogJobData>): Promise<void> {
    const { type, params } = job.data;
    if (type === 'user') {
      await this.auditLogService.writeUserAction(params as Parameters<AuditLogService['writeUserAction']>[0]);
    } else {
      await this.auditLogService.writeAdminAction(params as Parameters<AuditLogService['writeAdminAction']>[0]);
    }
  }

  @OnQueueFailed()
  async handleFailed(job: Job<AuditLogJobData>, err: Error): Promise<void> {
    if (job.attemptsMade >= (job.opts.attempts ?? 3)) {
      this.logger.error(
        `[AuditLog] CRITICAL: Exhausted retries for ${job.data.type} audit log — forwarding to dead-letter queue`,
        err.message,
      );
      await this.deadLetterQueue.add('audit-log-failed', {
        originalQueue: AUDIT_LOG_QUEUE,
        jobId: job.id,
        data: job.data,
        error: safeErrorMessage(err),
        failedAt: new Date().toISOString(),
      }, {
        jobId: deadLetterJobId(AUDIT_LOG_QUEUE, job.id),
        removeOnComplete: false,
        removeOnFail: false,
      }).catch((dlqErr: unknown) => {
        this.logger.error(`[AuditLog] CRITICAL: Dead-letter queue enqueue failed — audit event lost`, dlqErr);
      });
    }
  }
}
