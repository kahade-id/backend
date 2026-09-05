import { DashboardService } from './dashboard.service';
import { ChartQueryDto } from './dto/chart-query.dto';
export declare class DashboardController {
    private readonly service;
    constructor(service: DashboardService);
    getSummary(): Promise<object>;
    getCharts(query: ChartQueryDto): Promise<object>;
    getRecentActivity(): Promise<{
        data: object[];
    }>;
    getUserGrowth(query: ChartQueryDto): Promise<object>;
    getOrderStats(): Promise<object>;
}
