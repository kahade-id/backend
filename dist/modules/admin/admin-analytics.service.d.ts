import { PrismaService } from '../../prisma/prisma.service';
export declare class AdminAnalyticsService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    getOverview(startDate?: Date, endDate?: Date): Promise<object>;
    getOrderStats(startDate?: Date, endDate?: Date, groupBy?: 'day' | 'week' | 'month'): Promise<object[]>;
    getTopUsers(limit?: number, metric?: 'orders' | 'volume' | 'rating'): Promise<object[]>;
    getUserGrowth(startDate?: Date, endDate?: Date): Promise<object[]>;
    private assertDateRange;
    private buildDateFilter;
}
