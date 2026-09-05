import { Queue } from 'bull';
import { NotificationJobData } from './processors/notification.processor';
export declare class NotificationQueueService {
    private readonly notificationQueue;
    private readonly logger;
    constructor(notificationQueue: Queue<NotificationJobData>);
    enqueue(data: NotificationJobData): Promise<void>;
    enqueueMany(data: NotificationJobData[]): Promise<number>;
}
