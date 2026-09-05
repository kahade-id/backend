"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminReportsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../../prisma/prisma.service");
const audit_log_service_1 = require("../../../common/services/audit-log.service");
const pagination_dto_1 = require("../../../common/dto/pagination.dto");
const client_1 = require("@prisma/client");
const ErrorCodes = __importStar(require("../../../common/constants/error-codes"));
const MAX_ADMIN_PAGE = 100_000;
let AdminReportsService = class AdminReportsService {
    constructor(prisma, auditLog) {
        this.prisma = prisma;
        this.auditLog = auditLog;
    }
    async listReports(page, limit, status, category) {
        const safeLimit = Math.min(limit, 100);
        const safePage = Math.min(Math.max(page, 1), MAX_ADMIN_PAGE);
        const skip = (safePage - 1) * safeLimit;
        const where = {};
        if (status) {
            const validStatuses = ['PENDING', 'UNDER_REVIEW', 'RESOLVED_ACTION_TAKEN', 'RESOLVED_NO_ACTION', 'DISMISSED'];
            if (!validStatuses.includes(status)) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.INVALID_STATUS,
                    message: `Invalid report status: ${status}. Valid values: ${validStatuses.join(', ')}`,
                });
            }
            where.status = status;
        }
        if (category) {
            const validCategories = ['FRAUD', 'FAKE_IDENTITY', 'INAPPROPRIATE_CONTENT', 'TNC_VIOLATION', 'MONEY_LAUNDERING', 'SPAM', 'OTHER'];
            if (!validCategories.includes(category)) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.INVALID_STATUS,
                    message: `Invalid report category: ${category}. Valid values: ${validCategories.join(', ')}`,
                });
            }
            where.category = category;
        }
        const [reports, total] = await Promise.all([
            this.prisma.userReport.findMany({
                where,
                skip,
                take: safeLimit,
                orderBy: { createdAt: 'desc' },
                include: {
                    reporter: {
                        select: {
                            id: true,
                            userId: true,
                            username: true,
                            fullName: true,
                        },
                    },
                    target: {
                        select: {
                            id: true,
                            userId: true,
                            username: true,
                            fullName: true,
                        },
                    },
                },
            }),
            this.prisma.userReport.count({ where }),
        ]);
        return (0, pagination_dto_1.createPaginatedResponse)(reports, total, safePage, safeLimit);
    }
    async getReportDetail(reportId) {
        const report = await this.prisma.userReport.findUnique({
            where: { id: reportId },
            include: {
                reporter: {
                    select: {
                        id: true,
                        userId: true,
                        username: true,
                        fullName: true,
                        avatarUrl: true,
                    },
                },
                target: {
                    select: {
                        id: true,
                        userId: true,
                        username: true,
                        fullName: true,
                        avatarUrl: true,
                        isBanned: true,
                    },
                },
            },
        });
        if (!report) {
            throw new common_1.NotFoundException({
                code: ErrorCodes.REPORT_NOT_FOUND,
                message: 'Report not found',
            });
        }
        return report;
    }
    async resolveReport(reportId, resolution, adminId, ipAddress, resolveStatus = client_1.ReportStatus.RESOLVED_ACTION_TAKEN) {
        const report = await this.prisma.userReport.findUnique({
            where: { id: reportId },
        });
        if (!report) {
            throw new common_1.NotFoundException({
                code: ErrorCodes.REPORT_NOT_FOUND,
                message: 'Report not found',
            });
        }
        if (report.status === client_1.ReportStatus.RESOLVED_ACTION_TAKEN || report.status === client_1.ReportStatus.RESOLVED_NO_ACTION || report.status === client_1.ReportStatus.DISMISSED) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.REPORT_ALREADY_RESOLVED,
                message: 'Report has already been resolved or dismissed',
            });
        }
        const updated = await this.prisma.userReport.updateMany({
            where: { id: reportId, status: { in: [client_1.ReportStatus.PENDING, client_1.ReportStatus.UNDER_REVIEW] } },
            data: {
                status: resolveStatus,
                resolution,
                reviewedBy: adminId,
                reviewedAt: new Date(),
            },
        });
        if (updated.count !== 1) {
            throw new common_1.BadRequestException({ code: ErrorCodes.REPORT_ALREADY_RESOLVED, message: 'Report state changed; reload and try again' });
        }
        this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.ADMIN_ACTION,
            targetType: 'UserReport',
            targetId: reportId,
            description: `Resolved report ${reportId}: ${resolution}`,
            ipAddress,
        });
        return { message: 'Report resolved successfully', reportId };
    }
    async dismissReport(reportId, adminId, ipAddress) {
        const report = await this.prisma.userReport.findUnique({
            where: { id: reportId },
        });
        if (!report) {
            throw new common_1.NotFoundException({
                code: ErrorCodes.REPORT_NOT_FOUND,
                message: 'Report not found',
            });
        }
        if (report.status === client_1.ReportStatus.RESOLVED_ACTION_TAKEN || report.status === client_1.ReportStatus.RESOLVED_NO_ACTION || report.status === client_1.ReportStatus.DISMISSED) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.REPORT_ALREADY_RESOLVED,
                message: 'Report has already been resolved or dismissed',
            });
        }
        const updated = await this.prisma.userReport.updateMany({
            where: { id: reportId, status: { in: [client_1.ReportStatus.PENDING, client_1.ReportStatus.UNDER_REVIEW] } },
            data: {
                status: client_1.ReportStatus.DISMISSED,
                reviewedBy: adminId,
                reviewedAt: new Date(),
            },
        });
        if (updated.count !== 1) {
            throw new common_1.BadRequestException({ code: ErrorCodes.REPORT_ALREADY_RESOLVED, message: 'Report state changed; reload and try again' });
        }
        this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.ADMIN_ACTION,
            targetType: 'UserReport',
            targetId: reportId,
            description: `Dismissed report ${reportId}`,
            ipAddress,
        });
        return { message: 'Report dismissed successfully', reportId };
    }
};
exports.AdminReportsService = AdminReportsService;
exports.AdminReportsService = AdminReportsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        audit_log_service_1.AuditLogService])
], AdminReportsService);
