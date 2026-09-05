import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { NotificationQueueService } from '../../queue/notification-queue.service';
import { CreateBadgeDto, UpdateBadgeDto } from './dto/create-badge.dto';
export declare class AdminBadgesService {
    private prisma;
    private auditLog;
    private notificationQueue;
    private readonly logger;
    constructor(prisma: PrismaService, auditLog: AuditLogService, notificationQueue: NotificationQueueService);
    listBadges(page: number, limit: number): Promise<object>;
    getBadgeDetail(badgeId: string): Promise<object>;
    createBadge(adminId: string, dto: CreateBadgeDto, ipAddress: string): Promise<object>;
    updateBadge(badgeId: string, dto: UpdateBadgeDto, adminId: string, ipAddress: string): Promise<object>;
    deleteBadge(badgeId: string, adminId: string, ipAddress: string): Promise<{
        message: string;
    }>;
    awardBadge(badgeId: string, userId: string, adminId: string, ipAddress: string): Promise<object>;
    revokeBadge(badgeId: string, userId: string, adminId: string, ipAddress: string): Promise<{
        message: string;
    }>;
}
