import { AdminAnalyticsService } from '../admin-analytics.service';
import { Request } from 'express';
export declare class AdminAnalyticsController {
    private analyticsService;
    private readonly logger;
    constructor(analyticsService: AdminAnalyticsService);
    private logAdminAccess;
    getOverview(startDate?: string, endDate?: string, adminId?: string, req?: Request): Promise<object>;
    getOrderStats(groupBy: string, startDate?: string, endDate?: string, adminId?: string, req?: Request): Promise<object[]>;
    getTopUsers(limit: number, metric: string, adminId?: string, req?: Request): Promise<object[]>;
    getUserGrowth(startDate?: string, endDate?: string, adminId?: string, req?: Request): Promise<object[]>;
}
