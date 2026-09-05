import { Job, Queue } from 'bull';
import { AuditLogService, AuditLogJobData } from '../../../common/services/audit-log.service';
export declare class AuditLogProcessor {
    private readonly auditLogService;
    private readonly deadLetterQueue;
    private readonly logger;
    constructor(auditLogService: AuditLogService, deadLetterQueue: Queue);
    handleWrite(job: Job<AuditLogJobData>): Promise<void>;
    handleFailed(job: Job<AuditLogJobData>, err: Error): Promise<void>;
}
