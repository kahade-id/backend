import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { ReportStatus } from '@prisma/client';
export declare class AdminReportsService {
    private prisma;
    private auditLog;
    constructor(prisma: PrismaService, auditLog: AuditLogService);
    listReports(page: number, limit: number, status?: string, category?: string): Promise<object>;
    getReportDetail(reportId: string): Promise<object>;
    resolveReport(reportId: string, resolution: string, adminId: string, ipAddress: string, resolveStatus?: ReportStatus): Promise<{
        message: string;
        reportId: string;
    }>;
    dismissReport(reportId: string, adminId: string, ipAddress: string): Promise<{
        message: string;
        reportId: string;
    }>;
}
