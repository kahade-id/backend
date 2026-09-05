import { Controller, Get, Post, Put, Delete, Body, Param, Query, HttpCode, Req, BadRequestException, UseGuards } from '@nestjs/common';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { ParseQueryStringPipe } from '../../common/pipes/parse-query-string.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { NotificationPreference, NotificationCategory } from '@prisma/client';
import { NotificationsService, PublicNotification } from './notifications.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaginatedResponse } from '../../common/dto/pagination.dto';
import { ListNotificationsDto } from './dto/list-notifications.dto';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { BatchNotificationIdsDto } from './dto/batch-notifications.dto';
import { Request } from 'express';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';

@ApiTags('notifications')
@ApiBearerAuth('access-token')
@Controller('notifications')
export class NotificationsController {
  constructor(private notificationsService: NotificationsService) {}

  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get()
  async listNotifications(
    @CurrentUser('sub') userId: string,
    @Query() query: ListNotificationsDto,
  ): Promise<PaginatedResponse<PublicNotification>> {
    const isReadFilter = query.isRead === 'true' ? true : query.isRead === 'false' ? false : undefined;
    const categoryFilter = query.category ? this.parseCategoryOrThrow(query.category) : undefined;
    return this.notificationsService.listNotifications(userId, query.page ?? 1, query.limit ?? 20, isReadFilter, categoryFilter);
  }

  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get('unread-count')
  async getUnreadCount(
    @CurrentUser('sub') userId: string,
    @Query('category', new ParseQueryStringPipe('category', 50)) category?: string,
  ): Promise<{ unreadCount: number; perCategory?: Record<NotificationCategory, number> }> {
    const categoryFilter = category ? this.parseCategoryOrThrow(category) : undefined;
    return this.notificationsService.getUnreadCount(userId, categoryFilter);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 100 } })
  @Post(':notifId/read')
  async markAsRead(@CurrentUser('sub') userId: string, @Param('notifId', ParseIdPipe) notifId: string): Promise<PublicNotification> {
    return this.notificationsService.markAsRead(userId, notifId);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @Post('read-batch')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark multiple notifications as read by IDs' })
  async markBatchAsRead(
    @CurrentUser('sub') userId: string,
    @Body() dto: BatchNotificationIdsDto,
  ): Promise<{ markedCount: number }> {
    return this.notificationsService.markBatchAsRead(userId, dto.notifIds);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post('delete-batch')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete multiple notifications by IDs' })
  async deleteBatch(
    @CurrentUser('sub') userId: string,
    @Body() dto: BatchNotificationIdsDto,
  ): Promise<{ deletedCount: number }> {
    return this.notificationsService.deleteBatch(userId, dto.notifIds);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post('delete-read')
  @HttpCode(200)
  @ApiOperation({ summary: 'Soft-delete all read notifications owned by the current user' })
  async deleteAllRead(@CurrentUser('sub') userId: string): Promise<{ deletedCount: number }> {
    return this.notificationsService.deleteAllRead(userId);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post('read-all')
  @HttpCode(200)
  async markAllAsRead(@CurrentUser('sub') userId: string): Promise<{ markedCount: number }> {
    return this.notificationsService.markAllAsRead(userId);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get('preferences')
  async getPreferences(@CurrentUser('sub') userId: string): Promise<NotificationPreference> {
    return this.notificationsService.getPreferences(userId);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Put('preferences')
  async updatePreferences(@CurrentUser('sub') userId: string, @Body() dto: UpdatePreferencesDto): Promise<NotificationPreference> {
    return this.notificationsService.updatePreferences(userId, dto);
  }

  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get(':notifId')
  async getNotification(
    @CurrentUser('sub') userId: string,
    @Param('notifId', ParseIdPipe) notifId: string,
  ) {
    return this.notificationsService.getNotification(userId, notifId);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Delete(':notifId')
  @ApiOperation({ summary: 'Delete a notification' })
  async deleteNotification(
    @CurrentUser('sub') userId: string,
    @Param('notifId', ParseIdPipe) notifId: string,
  ): Promise<{ message: string }> {
    return this.notificationsService.deleteNotification(userId, notifId);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Post('register-device')
  @ApiOperation({ summary: 'Register push notification token' })
  async registerDevice(
    @CurrentUser('sub') userId: string,
    @Body() dto: RegisterDeviceDto,
    @Req() req: Request,
  ): Promise<{ message: string; deviceId: string }> {
    const ipAddress = req.ip || req.socket?.remoteAddress || '0.0.0.0';
    return this.notificationsService.registerDevice(userId, dto.token, dto.platform, ipAddress, dto.deviceId);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Post('unregister-device')
  @HttpCode(200)
  @ApiOperation({ summary: 'Unregister push notification token' })
  async unregisterDevice(
    @CurrentUser('sub') userId: string,
    @Body('deviceId') deviceId: string,
  ): Promise<{ message: string }> {
    return this.notificationsService.unregisterDevice(userId, deviceId);
  }

  private parseCategoryOrThrow(value: string): NotificationCategory {
    const map: Record<string, NotificationCategory> = {
      INFORMASI: NotificationCategory.INFORMASI,
      PROMOSI: NotificationCategory.PROMOSI,
      TRANSAKSI: NotificationCategory.TRANSAKSI,
    };
    const resolved = map[value.toUpperCase()];
    if (!resolved) {
      throw new BadRequestException({ code: 'INVALID_CATEGORY', message: `Invalid category. Must be one of: INFORMASI, PROMOSI, TRANSAKSI` });
    }
    return resolved;
  }
}
