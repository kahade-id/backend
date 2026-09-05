import { AdminSubscriptionsService } from './admin-subscriptions.service';
import { SubscriptionListQueryDto } from './dto/subscription-list-query.dto';
import { Request } from 'express';
export declare class AdminSubscriptionsController {
    private readonly service;
    constructor(service: AdminSubscriptionsService);
    listSubscriptions(query: SubscriptionListQueryDto): Promise<object>;
    getSubscriptionDetail(subId: string): Promise<object>;
    forceCancelSubscription(subId: string, adminId: string, req: Request): Promise<{
        message: string;
        subscriptionId: string;
        status: string;
    }>;
}
