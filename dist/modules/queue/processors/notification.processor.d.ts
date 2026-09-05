import { Job, Queue } from 'bull';
import { NotificationChannel, NotificationType } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
export declare const NOTIFICATION_QUEUE = "notification";
export interface NotificationJobData {
    userId: string;
    type: NotificationType;
    title: string;
    body: string;
    pushData?: Record<string, string>;
    actionUrl?: string;
    language?: string;
    channel?: NotificationChannel;
}
export declare class NotificationProcessor {
    private prisma;
    private readonly deadLetterQueue;
    private readonly logger;
    constructor(prisma: PrismaService, deadLetterQueue: Queue);
    handleSendNotification(job: Job<NotificationJobData>): Promise<void>;
    private deriveActionUrl;
    onJobFailed(job: Job<NotificationJobData>, error: Error): Promise<void>;
}
