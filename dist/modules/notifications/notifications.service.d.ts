import { Notification, NotificationPreference, NotificationCategory, NotificationType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginatedResponse } from '../../common/dto/pagination.dto';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
export type PublicNotification = Pick<Notification, 'notifId' | 'type' | 'category' | 'channel' | 'title' | 'body' | 'actionUrl' | 'isRead' | 'readAt' | 'createdAt' | 'expiresAt' | 'metadata'>;
export declare class NotificationsService {
    private prisma;
    private readonly logger;
    constructor(prisma: PrismaService);
    isDuplicate(userId: string, type: NotificationType, body: string): Promise<boolean>;
    isDuplicateByRef(userId: string, type: NotificationType, refId: string): Promise<boolean>;
    private disabledInAppTypes;
    private notificationVisibilityWhere;
    listNotifications(userId: string, page: number, limit: number, isRead?: boolean, category?: NotificationCategory): Promise<PaginatedResponse<PublicNotification>>;
    getNotification(userId: string, notifId: string): Promise<PublicNotification>;
    getUnreadCount(userId: string, category?: NotificationCategory): Promise<{
        unreadCount: number;
        perCategory?: Record<NotificationCategory, number>;
    }>;
    markAsRead(userId: string, notifId: string): Promise<PublicNotification>;
    markBatchAsRead(userId: string, notifIds: string[]): Promise<{
        markedCount: number;
    }>;
    deleteBatch(userId: string, notifIds: string[]): Promise<{
        deletedCount: number;
    }>;
    deleteAllRead(userId: string): Promise<{
        deletedCount: number;
    }>;
    markAllAsRead(userId: string): Promise<{
        markedCount: number;
    }>;
    getPreferences(userId: string): Promise<NotificationPreference>;
    updatePreferences(userId: string, dto: UpdatePreferencesDto): Promise<NotificationPreference>;
    deleteNotification(userId: string, notifId: string): Promise<{
        message: string;
    }>;
    registerDevice(userId: string, token: string, platform?: string, ipAddress?: string, deviceId?: string): Promise<{
        message: string;
        deviceId: string;
    }>;
    unregisterDevice(userId: string, deviceId: string): Promise<{
        message: string;
    }>;
}
