import { Processor, Process, OnQueueFailed, OnQueueCompleted } from '@nestjs/bull';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bull';
import { ReconciliationService, ReconciliationResult } from './reconciliation.service';

export const RECONCILIATION_QUEUE = 'reconciliation';

export interface ReconciliationJobData {
  requestedBy: string;
  requestedAt: string;
}

@Injectable()
@Processor(RECONCILIATION_QUEUE)
export class ReconciliationProcessor {
  private readonly logger = new Logger(ReconciliationProcessor.name);

  constructor(private readonly reconciliationService: ReconciliationService) {}

  @Process({ name: 'reconcile-all', concurrency: 1 })
  async handleReconcileAll(job: Job<ReconciliationJobData>): Promise<ReconciliationResult> {
    this.logger.log(`Starting reconcile-all job ${job.id} (requested by ${job.data.requestedBy}), attempt ${job.attemptsMade + 1}`);
    const result = await this.reconciliationService.reconcileAllWallets();
    this.logger.log(
      `Reconcile-all job ${job.id} complete: ${result.walletsChecked} wallets, ` +
      `${result.discrepancies.length} discrepancies`,
    );
    return result;
  }

  @OnQueueFailed()
  onJobFailed(job: Job<ReconciliationJobData>, error: Error): void {
    this.logger.error(`Reconciliation job ${job.id} FAILED (attempt ${job.attemptsMade}/${job.opts.attempts ?? 1}): ${error.message}`, error.stack);
  }

  @OnQueueCompleted()
  onJobCompleted(job: Job<ReconciliationJobData>): void {
    this.logger.debug(`Reconciliation job ${job.id} completed`);
  }
}
