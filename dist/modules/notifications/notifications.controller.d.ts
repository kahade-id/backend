import { NotificationPreference, NotificationCategory } from '@prisma/client';
import { NotificationsService, PublicNotification } from './notifications.service';
import { PaginatedResponse } from '../../common/dto/pagination.dto';
import { ListNotificationsDto } from './dto/list-notifications.dto';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { BatchNotificationIdsDto } from './dto/batch-notifications.dto';
import { Request } from 'express';
export declare class NotificationsController {
    private notificationsService;
    constructor(notificationsService: NotificationsService);
    listNotifications(userId: string, query: ListNotificationsDto): Promise<PaginatedResponse<PublicNotification>>;
    getUnreadCount(userId: string, category?: string): Promise<{
        unreadCount: number;
        perCategory?: Record<NotificationCategory, number>;
    }>;
    markAsRead(userId: string, notifId: string): Promise<PublicNotification>;
    markBatchAsRead(userId: string, dto: BatchNotificationIdsDto): Promise<{
        markedCount: number;
    }>;
    deleteBatch(userId: string, dto: BatchNotificationIdsDto): Promise<{
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
    getNotification(userId: string, notifId: string): Promise<PublicNotification>;
    deleteNotification(userId: string, notifId: string): Promise<{
        message: string;
    }>;
    registerDevice(userId: string, dto: RegisterDeviceDto, req: Request): Promise<{
        message: string;
        deviceId: string;
    }>;
    unregisterDevice(userId: string, deviceId: string): Promise<{
        message: string;
    }>;
    private parseCategoryOrThrow;
}
