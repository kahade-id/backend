"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationsController = void 0;
const common_1 = require("@nestjs/common");
const parse_id_pipe_1 = require("../../common/pipes/parse-id.pipe");
const parse_query_string_pipe_1 = require("../../common/pipes/parse-query-string.pipe");
const swagger_1 = require("@nestjs/swagger");
const throttler_1 = require("@nestjs/throttler");
const client_1 = require("@prisma/client");
const notifications_service_1 = require("./notifications.service");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const list_notifications_dto_1 = require("./dto/list-notifications.dto");
const update_preferences_dto_1 = require("./dto/update-preferences.dto");
const register_device_dto_1 = require("./dto/register-device.dto");
const batch_notifications_dto_1 = require("./dto/batch-notifications.dto");
const user_throttle_guard_1 = require("../../common/guards/user-throttle.guard");
let NotificationsController = class NotificationsController {
    constructor(notificationsService) {
        this.notificationsService = notificationsService;
    }
    async listNotifications(userId, query) {
        const isReadFilter = query.isRead === 'true' ? true : query.isRead === 'false' ? false : undefined;
        const categoryFilter = query.category ? this.parseCategoryOrThrow(query.category) : undefined;
        return this.notificationsService.listNotifications(userId, query.page ?? 1, query.limit ?? 20, isReadFilter, categoryFilter);
    }
    async getUnreadCount(userId, category) {
        const categoryFilter = category ? this.parseCategoryOrThrow(category) : undefined;
        return this.notificationsService.getUnreadCount(userId, categoryFilter);
    }
    async markAsRead(userId, notifId) {
        return this.notificationsService.markAsRead(userId, notifId);
    }
    async markBatchAsRead(userId, dto) {
        return this.notificationsService.markBatchAsRead(userId, dto.notifIds);
    }
    async deleteBatch(userId, dto) {
        return this.notificationsService.deleteBatch(userId, dto.notifIds);
    }
    async deleteAllRead(userId) {
        return this.notificationsService.deleteAllRead(userId);
    }
    async markAllAsRead(userId) {
        return this.notificationsService.markAllAsRead(userId);
    }
    async getPreferences(userId) {
        return this.notificationsService.getPreferences(userId);
    }
    async updatePreferences(userId, dto) {
        return this.notificationsService.updatePreferences(userId, dto);
    }
    async getNotification(userId, notifId) {
        return this.notificationsService.getNotification(userId, notifId);
    }
    async deleteNotification(userId, notifId) {
        return this.notificationsService.deleteNotification(userId, notifId);
    }
    async registerDevice(userId, dto, req) {
        const ipAddress = req.ip || req.socket?.remoteAddress || '0.0.0.0';
        return this.notificationsService.registerDevice(userId, dto.token, dto.platform, ipAddress, dto.deviceId);
    }
    async unregisterDevice(userId, deviceId) {
        return this.notificationsService.unregisterDevice(userId, deviceId);
    }
    parseCategoryOrThrow(value) {
        const map = {
            INFORMASI: client_1.NotificationCategory.INFORMASI,
            PROMOSI: client_1.NotificationCategory.PROMOSI,
            TRANSAKSI: client_1.NotificationCategory.TRANSAKSI,
        };
        const resolved = map[value.toUpperCase()];
        if (!resolved) {
            throw new common_1.BadRequestException({ code: 'INVALID_CATEGORY', message: `Invalid category. Must be one of: INFORMASI, PROMOSI, TRANSAKSI` });
        }
        return resolved;
    }
};
exports.NotificationsController = NotificationsController;
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 60 } }),
    (0, common_1.Get)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, list_notifications_dto_1.ListNotificationsDto]),
    __metadata("design:returntype", Promise)
], NotificationsController.prototype, "listNotifications", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 60 } }),
    (0, common_1.Get)('unread-count'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)('category', new parse_query_string_pipe_1.ParseQueryStringPipe('category', 50))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], NotificationsController.prototype, "getUnreadCount", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 100 } }),
    (0, common_1.Post)(':notifId/read'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('notifId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], NotificationsController.prototype, "markAsRead", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 20 } }),
    (0, common_1.Post)('read-batch'),
    (0, common_1.HttpCode)(200),
    (0, swagger_1.ApiOperation)({ summary: 'Mark multiple notifications as read by IDs' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, batch_notifications_dto_1.BatchNotificationIdsDto]),
    __metadata("design:returntype", Promise)
], NotificationsController.prototype, "markBatchAsRead", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, common_1.Post)('delete-batch'),
    (0, common_1.HttpCode)(200),
    (0, swagger_1.ApiOperation)({ summary: 'Delete multiple notifications by IDs' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, batch_notifications_dto_1.BatchNotificationIdsDto]),
    __metadata("design:returntype", Promise)
], NotificationsController.prototype, "deleteBatch", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, common_1.Post)('delete-read'),
    (0, common_1.HttpCode)(200),
    (0, swagger_1.ApiOperation)({ summary: 'Soft-delete all read notifications owned by the current user' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], NotificationsController.prototype, "deleteAllRead", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, common_1.Post)('read-all'),
    (0, common_1.HttpCode)(200),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], NotificationsController.prototype, "markAllAsRead", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Get)('preferences'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], NotificationsController.prototype, "getPreferences", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, common_1.Put)('preferences'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, update_preferences_dto_1.UpdatePreferencesDto]),
    __metadata("design:returntype", Promise)
], NotificationsController.prototype, "updatePreferences", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 60 } }),
    (0, common_1.Get)(':notifId'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('notifId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], NotificationsController.prototype, "getNotification", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Delete)(':notifId'),
    (0, swagger_1.ApiOperation)({ summary: 'Delete a notification' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('notifId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], NotificationsController.prototype, "deleteNotification", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 5 } }),
    (0, common_1.Post)('register-device'),
    (0, swagger_1.ApiOperation)({ summary: 'Register push notification token' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, register_device_dto_1.RegisterDeviceDto, Object]),
    __metadata("design:returntype", Promise)
], NotificationsController.prototype, "registerDevice", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 5 } }),
    (0, common_1.Post)('unregister-device'),
    (0, common_1.HttpCode)(200),
    (0, swagger_1.ApiOperation)({ summary: 'Unregister push notification token' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)('deviceId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], NotificationsController.prototype, "unregisterDevice", null);
exports.NotificationsController = NotificationsController = __decorate([
    (0, swagger_1.ApiTags)('notifications'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.Controller)('notifications'),
    __metadata("design:paramtypes", [notifications_service_1.NotificationsService])
], NotificationsController);
