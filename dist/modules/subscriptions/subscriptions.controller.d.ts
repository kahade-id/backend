import { Request } from 'express';
import { Subscription } from '@prisma/client';
import { SubscriptionsService } from './subscriptions.service';
import { PaginatedResponse } from '../../common/dto/pagination.dto';
import { SubscribeDto, RenewDto } from './dto/subscribe.dto';
export declare class SubscriptionsController {
    private subscriptionsService;
    constructor(subscriptionsService: SubscriptionsService);
    getStatus(userId: string): Promise<Record<string, unknown>>;
    subscribe(userId: string, dto: SubscribeDto, req: Request): Promise<Subscription>;
    cancel(userId: string): Promise<Subscription>;
    getHistory(userId: string, page: number, limit: number): Promise<PaginatedResponse<Record<string, unknown>>>;
    getBenefits(userId: string): Promise<Record<string, unknown>>;
    renew(userId: string, dto: RenewDto, req: Request): Promise<Subscription>;
    getPlans(): Promise<Array<{
        plan: string;
        label: string;
        price: number;
        durationDays: number;
        feeSavingsLimit: number;
    }>>;
}
