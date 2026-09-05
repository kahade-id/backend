import { AdminReportsService } from './admin-reports.service';
import { ReportQueryDto } from './dto/report-query.dto';
import { ResolveReportDto } from './dto/resolve-report.dto';
import { AdminJwtPayload } from '../../../common/types/jwt-payload.types';
import { Request } from 'express';
export declare class AdminReportsController {
    private readonly service;
    constructor(service: AdminReportsService);
    listReports(query: ReportQueryDto): Promise<object>;
    getReportDetail(reportId: string): Promise<object>;
    resolveReport(reportId: string, dto: ResolveReportDto, admin: AdminJwtPayload, req: Request): Promise<{
        message: string;
        reportId: string;
    }>;
    dismissReport(reportId: string, admin: AdminJwtPayload, req: Request): Promise<{
        message: string;
        reportId: string;
    }>;
}
