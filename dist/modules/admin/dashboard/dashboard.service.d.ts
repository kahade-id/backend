import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { ChartQueryDto } from './dto/chart-query.dto';
export declare class DashboardService {
    private prisma;
    private redis;
    constructor(prisma: PrismaService, redis: RedisService);
    getSummary(): Promise<object>;
    private getPeriodStartDate;
    private getDateRange;
    getCharts(query: ChartQueryDto): Promise<object>;
    getRecentActivity(): Promise<{
        data: object[];
    }>;
    getUserGrowth(query: ChartQueryDto): Promise<object>;
    getOrderStats(): Promise<object>;
}
