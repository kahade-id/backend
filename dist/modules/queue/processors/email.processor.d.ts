import { OnModuleDestroy } from '@nestjs/common';
import { Job, Queue } from 'bull';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../../redis/redis.service';
import { TemplateService } from '../../../common/services/template.service';
export declare const EMAIL_QUEUE = "email";
export interface EmailJobData {
    to: string;
    subject: string;
    html?: string;
    text?: string;
    templateName?: string;
    templateContext?: Record<string, unknown>;
}
export declare class EmailProcessor implements OnModuleDestroy {
    private configService;
    private redisService;
    private templateService;
    private readonly deadLetterQueue;
    private readonly logger;
    private transporter;
    constructor(configService: ConfigService, redisService: RedisService, templateService: TemplateService, deadLetterQueue: Queue);
    onModuleDestroy(): void;
    private getTransporter;
    handleSendEmail(job: Job<EmailJobData>): Promise<void>;
    onJobFailed(job: Job<EmailJobData>, error: Error): Promise<void>;
    onJobCompleted(job: Job<EmailJobData>): void;
}
