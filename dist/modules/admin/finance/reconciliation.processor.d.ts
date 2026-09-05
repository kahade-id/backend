import { Job } from 'bull';
import { ReconciliationService, ReconciliationResult } from './reconciliation.service';
export declare const RECONCILIATION_QUEUE = "reconciliation";
export interface ReconciliationJobData {
    requestedBy: string;
    requestedAt: string;
}
export declare class ReconciliationProcessor {
    private readonly reconciliationService;
    private readonly logger;
    constructor(reconciliationService: ReconciliationService);
    handleReconcileAll(job: Job<ReconciliationJobData>): Promise<ReconciliationResult>;
    onJobFailed(job: Job<ReconciliationJobData>, error: Error): void;
    onJobCompleted(job: Job<ReconciliationJobData>): void;
}
