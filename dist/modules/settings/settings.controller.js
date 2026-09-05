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
exports.SettingsController = void 0;
const common_1 = require("@nestjs/common");
const parse_id_pipe_1 = require("../../common/pipes/parse-id.pipe");
const swagger_1 = require("@nestjs/swagger");
const throttler_1 = require("@nestjs/throttler");
const settings_service_1 = require("./settings.service");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const user_throttle_guard_1 = require("../../common/guards/user-throttle.guard");
const pagination_dto_1 = require("../../common/dto/pagination.dto");
const report_user_dto_1 = require("./dto/report-user.dto");
const update_privacy_dto_1 = require("./dto/update-privacy.dto");
const update_language_dto_1 = require("./dto/update-language.dto");
let SettingsController = class SettingsController {
    constructor(settingsService) {
        this.settingsService = settingsService;
    }
    listBlockedUsers(userId, pagination) {
        return this.settingsService.listBlockedUsers(userId, pagination.page ?? 1, pagination.limit ?? 20);
    }
    blockUser(currentUserId, targetUserId) {
        return this.settingsService.blockUser(currentUserId, targetUserId);
    }
    unblockUser(currentUserId, targetUserId) {
        return this.settingsService.unblockUser(currentUserId, targetUserId);
    }
    reportUser(userId, dto) {
        return this.settingsService.reportUser(userId, dto);
    }
    listMyReports(userId, pagination) {
        return this.settingsService.listMyReports(userId, pagination.page ?? 1, pagination.limit ?? 20);
    }
    getPrivacySettings(userId) {
        return this.settingsService.getPrivacySettings(userId);
    }
    updatePrivacySettings(userId, dto) {
        return this.settingsService.updatePrivacySettings(userId, dto);
    }
    getLanguage(userId) {
        return this.settingsService.getLanguage(userId);
    }
    updateLanguage(userId, dto) {
        return this.settingsService.updateLanguage(userId, dto.language);
    }
    requestDataExport(userId) {
        return this.settingsService.requestDataExport(userId);
    }
};
exports.SettingsController = SettingsController;
__decorate([
    (0, common_1.Get)('blocked-users'),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 20 } }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, pagination_dto_1.PaginationDto]),
    __metadata("design:returntype", Promise)
], SettingsController.prototype, "listBlockedUsers", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, common_1.Post)('block/:userId'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('userId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], SettingsController.prototype, "blockUser", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, common_1.Delete)('block/:userId'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('userId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], SettingsController.prototype, "unblockUser", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 3600000, limit: 5 } }),
    (0, common_1.Post)('report'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, report_user_dto_1.ReportUserSettingsDto]),
    __metadata("design:returntype", Promise)
], SettingsController.prototype, "reportUser", null);
__decorate([
    (0, common_1.Get)('reports'),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 20 } }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, pagination_dto_1.PaginationDto]),
    __metadata("design:returntype", Promise)
], SettingsController.prototype, "listMyReports", null);
__decorate([
    (0, common_1.Get)('privacy'),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 20 } }),
    (0, swagger_1.ApiOperation)({ summary: 'Get privacy settings' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], SettingsController.prototype, "getPrivacySettings", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, common_1.Put)('privacy'),
    (0, swagger_1.ApiOperation)({ summary: 'Update privacy settings' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, update_privacy_dto_1.UpdatePrivacyDto]),
    __metadata("design:returntype", Promise)
], SettingsController.prototype, "updatePrivacySettings", null);
__decorate([
    (0, common_1.Get)('language'),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 20 } }),
    (0, swagger_1.ApiOperation)({ summary: 'Get language preference' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], SettingsController.prototype, "getLanguage", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 20 } }),
    (0, common_1.Put)('language'),
    (0, swagger_1.ApiOperation)({ summary: 'Update language preference' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, update_language_dto_1.UpdateLanguageDto]),
    __metadata("design:returntype", Promise)
], SettingsController.prototype, "updateLanguage", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 86400000, limit: 3 } }),
    (0, common_1.Post)('privacy/export'),
    (0, swagger_1.ApiOperation)({ summary: 'Request personal data export' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], SettingsController.prototype, "requestDataExport", null);
exports.SettingsController = SettingsController = __decorate([
    (0, swagger_1.ApiTags)('settings'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.Controller)('settings'),
    __metadata("design:paramtypes", [settings_service_1.SettingsService])
], SettingsController);
