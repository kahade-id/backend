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
exports.UsersController = void 0;
const common_1 = require("@nestjs/common");
const parse_id_pipe_1 = require("../../common/pipes/parse-id.pipe");
const parse_username_pipe_1 = require("../../common/pipes/parse-username.pipe");
const clamp_limit_pipe_1 = require("../../common/pipes/clamp-limit.pipe");
const parse_query_string_pipe_1 = require("../../common/pipes/parse-query-string.pipe");
const platform_express_1 = require("@nestjs/platform-express");
const swagger_1 = require("@nestjs/swagger");
const throttler_1 = require("@nestjs/throttler");
const users_service_1 = require("./users.service");
const user_search_service_1 = require("./user-search.service");
const user_stats_service_1 = require("./user-stats.service");
const user_analytics_service_1 = require("./user-analytics.service");
const profile_qa_service_1 = require("./profile-qa.service");
const og_metadata_service_1 = require("./og-metadata.service");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const idempotency_decorator_1 = require("../../common/decorators/idempotency.decorator");
const public_decorator_1 = require("../../common/decorators/public.decorator");
const update_profile_dto_1 = require("./dto/update-profile.dto");
const confirm_avatar_dto_1 = require("./dto/confirm-avatar.dto");
const report_user_dto_1 = require("./dto/report-user.dto");
const update_links_dto_1 = require("./dto/update-links.dto");
const upload_avatar_dto_1 = require("./dto/upload-avatar.dto");
const confirm_header_dto_1 = require("./dto/confirm-header.dto");
const request_account_deletion_dto_1 = require("./dto/request-account-deletion.dto");
const profile_question_dto_1 = require("./dto/profile-question.dto");
const showcase_dto_1 = require("./dto/showcase.dto");
const trust_device_dto_1 = require("./dto/trust-device.dto");
const user_throttle_guard_1 = require("../../common/guards/user-throttle.guard");
let UsersController = class UsersController {
    constructor(usersService, userSearchService, userStatsService, userAnalyticsService, profileQAService, ogMetadataService) {
        this.usersService = usersService;
        this.userSearchService = userSearchService;
        this.userStatsService = userStatsService;
        this.userAnalyticsService = userAnalyticsService;
        this.profileQAService = profileQAService;
        this.ogMetadataService = ogMetadataService;
    }
    async getMyProfile(userId) {
        return this.usersService.getMyProfile(userId);
    }
    async updateProfile(userId, dto) {
        return this.usersService.updateProfile(userId, dto);
    }
    async getMyStats(userId) {
        return this.usersService.getMyStats(userId);
    }
    async getMyAnalytics(userId, period) {
        return this.userAnalyticsService.getUserAnalytics(userId, period || '30d');
    }
    async getMyTrustScore(userId) {
        const analytics = await this.userAnalyticsService.getUserAnalytics(userId, '30d');
        const score = analytics.overview.trustScore;
        const badge = this.userAnalyticsService.getTrustBadge(score);
        return { score, badge };
    }
    async uploadAvatar(userId, dto) {
        return this.usersService.uploadAvatar(userId, dto?.contentType);
    }
    async confirmAvatar(userId, dto) {
        return this.usersService.confirmAvatar(userId, dto.avatarKey.trim());
    }
    async uploadAvatarDirect(userId, file) {
        if (!file) {
            throw new common_1.BadRequestException({ code: 'FILE_REQUIRED', message: 'File is required' });
        }
        return this.usersService.uploadAvatarDirect(userId, file.originalname, file.mimetype, file.buffer);
    }
    async deleteAvatar(userId) {
        return this.usersService.deleteAvatar(userId);
    }
    async uploadHeader(userId, dto) {
        return this.usersService.uploadHeader(userId, dto?.contentType);
    }
    async confirmHeader(userId, dto) {
        return this.usersService.confirmHeader(userId, dto.headerKey.trim());
    }
    async uploadHeaderDirect(userId, file) {
        if (!file) {
            throw new common_1.BadRequestException({ code: 'FILE_REQUIRED', message: 'File is required' });
        }
        return this.usersService.uploadHeaderDirect(userId, file.originalname, file.mimetype, file.buffer);
    }
    async deleteHeader(userId) {
        return this.usersService.deleteHeader(userId);
    }
    async getMyLinks(userId) {
        return this.usersService.getMyLinks(userId);
    }
    async updateLinks(userId, dto) {
        return this.usersService.updateLinks(userId, dto);
    }
    async getBlockedUsers(userId, page, limit) {
        return this.usersService.getBlockedUsers(userId, page, limit);
    }
    async requestAccountDeletion(userId, accessTokenJti, dto) {
        return this.usersService.requestAccountDeletion(userId, accessTokenJti, dto.password, dto.reason, dto.mfaCode);
    }
    async getMyDevices(userId, page, limit) {
        return this.usersService.getMyDevices(userId, page, limit);
    }
    async removeDevice(userId, deviceId) {
        return this.usersService.removeDevice(userId, deviceId);
    }
    async trustDevice(userId, deviceId, dto) {
        return this.usersService.setDeviceTrust(userId, deviceId, true, dto.password, dto.mfaCode);
    }
    async untrustDevice(userId, deviceId, dto) {
        return this.usersService.setDeviceTrust(userId, deviceId, false, dto.password, dto.mfaCode);
    }
    async getSecurityLog(userId, page, limit, action) {
        return this.usersService.getSecurityLog(userId, page, limit, action);
    }
    async getActivityLog(userId, page, limit) {
        return this.usersService.getActivityLog(userId, page, limit);
    }
    async checkUsernameAvailability(username) {
        if (!username || username.trim().length < 3) {
            throw new common_1.BadRequestException({ code: 'VALIDATION_ERROR', message: 'username must be at least 3 characters' });
        }
        if (username.length > 50) {
            throw new common_1.BadRequestException({ code: 'VALIDATION_ERROR', message: 'username must not exceed 50 characters' });
        }
        return this.usersService.checkUsernameAvailability(username);
    }
    async getFavorites(userId, page, limit) {
        return this.usersService.getFavorites(userId, page, limit);
    }
    async getSavedProfiles(userId, page, limit) {
        return this.usersService.getSavedProfiles(userId, page, limit);
    }
    async searchUsers(userId, query, page, limit) {
        if (!query || query.trim().length < 2) {
            throw new common_1.BadRequestException({ code: 'VALIDATION_ERROR', message: 'Search query must be at least 2 characters' });
        }
        return this.usersService.searchUsers(query, page, limit, userId);
    }
    async discoverUsers(userId, query, page, limit, minRating, minTransactions, isKycVerified, membershipRank) {
        return this.userSearchService.searchUsers(query || '', {
            minRating: minRating ? Number(minRating) : undefined,
            minTransactions: minTransactions ? Number(minTransactions) : undefined,
            isKycVerified: isKycVerified === 'true',
            membershipRank,
        }, page, limit, userId);
    }
    async getDashboardStats(userId) {
        return this.userStatsService.getDashboardStats(userId);
    }
    async uploadShowcaseImage(userId, file) {
        if (!file) {
            throw new common_1.BadRequestException({ code: 'FILE_REQUIRED', message: 'File is required' });
        }
        return this.usersService.uploadShowcaseImage(userId, file.originalname, file.mimetype, file.buffer);
    }
    async getMyShowcase(userId) {
        return this.usersService.getMyShowcase(userId);
    }
    async createShowcaseItem(userId, dto) {
        return this.usersService.createShowcaseItem(userId, dto);
    }
    async updateShowcaseItem(userId, itemId, dto) {
        return this.usersService.updateShowcaseItem(userId, itemId, dto);
    }
    async deleteShowcaseItem(userId, itemId) {
        return this.usersService.deleteShowcaseItem(userId, itemId);
    }
    async getMyQuestions(userId, type, page, limit) {
        return this.profileQAService.getMyQuestions(userId, type, page, limit);
    }
    async checkFavorite(userId, username) {
        return this.usersService.checkFavorite(userId, username);
    }
    async addFavorite(userId, username) {
        return this.usersService.addFavorite(userId, username);
    }
    async removeFavorite(userId, username) {
        return this.usersService.removeFavorite(userId, username);
    }
    async checkSavedProfile(userId, username) {
        return this.usersService.checkSavedProfile(userId, username);
    }
    async saveProfile(userId, username) {
        return this.usersService.saveProfile(userId, username);
    }
    async removeSavedProfile(userId, username) {
        return this.usersService.removeSavedProfile(userId, username);
    }
    async blockUser(userId, targetUserId) {
        return this.usersService.blockUser(userId, targetUserId);
    }
    async unblockUser(userId, targetUserId) {
        return this.usersService.unblockUser(userId, targetUserId);
    }
    async reportUser(userId, targetUserId, dto) {
        return this.usersService.reportUser(userId, targetUserId, dto);
    }
    async getPublicProfile(username, viewerId) {
        if (!username || username.length > 30 || !/^[a-zA-Z0-9_.-]+$/.test(username)) {
            throw new common_1.BadRequestException({ code: 'INVALID_USERNAME', message: 'Invalid username format' });
        }
        return this.usersService.getPublicProfile(username, viewerId ?? undefined);
    }
    async getShowcase(username, viewerId) {
        return this.usersService.getShowcaseByUsername(username, viewerId ?? undefined);
    }
    async followUser(userId, username) {
        return this.usersService.followUser(userId, username);
    }
    async unfollowUser(userId, username) {
        return this.usersService.unfollowUser(userId, username);
    }
    async getFollowers(username, viewerId, page, limit, search) {
        return this.usersService.getFollowers(username, page, limit, search, viewerId);
    }
    async getFollowing(username, viewerId, page, limit) {
        return this.usersService.getFollowing(username, page, limit, viewerId);
    }
    async getUserRatings(username, viewerId, page, limit, filter) {
        return this.usersService.getUserRatings(username, page, limit, filter, viewerId);
    }
    async askQuestion(userId, username, dto) {
        return this.profileQAService.askQuestion(userId, username, dto.question);
    }
    async getProfileQuestions(username, page, limit) {
        return this.profileQAService.getProfileQuestions(username, page, limit);
    }
    async answerQuestion(userId, questionId, dto) {
        return this.profileQAService.answerQuestion(userId, questionId, dto.answer);
    }
    async deleteQuestion(userId, questionId) {
        return this.profileQAService.deleteQuestion(userId, questionId);
    }
    async addComment(userId, questionId, dto) {
        return this.profileQAService.addComment(userId, questionId, dto.content, dto.parentId);
    }
    async getComments(questionId, page, limit) {
        return this.profileQAService.getComments(questionId, page, limit);
    }
    async deleteComment(userId, commentId) {
        return this.profileQAService.deleteComment(userId, commentId);
    }
    async getUserOgMetadata(username) {
        return this.ogMetadataService.getUserOgMetadata(username);
    }
};
exports.UsersController = UsersController;
__decorate([
    (0, common_1.Get)('me'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "getMyProfile", null);
__decorate([
    (0, common_1.Put)('me'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, update_profile_dto_1.UpdateProfileDto]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "updateProfile", null);
__decorate([
    (0, common_1.Get)('me/stats'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "getMyStats", null);
__decorate([
    (0, common_1.Get)('me/analytics'),
    (0, swagger_1.ApiOperation)({ summary: 'Get user analytics dashboard data' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)('period', new parse_query_string_pipe_1.ParseQueryStringPipe('period', 10))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "getMyAnalytics", null);
__decorate([
    (0, common_1.Get)('me/trust-score'),
    (0, swagger_1.ApiOperation)({ summary: 'Get user trust score and badge' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "getMyTrustScore", null);
__decorate([
    (0, common_1.Put)('me/avatar'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, upload_avatar_dto_1.UploadAvatarDto]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "uploadAvatar", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Post)('me/avatar/confirm'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, confirm_avatar_dto_1.ConfirmAvatarDto]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "confirmAvatar", null);
__decorate([
    (0, common_1.Post)('me/avatar/direct'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, swagger_1.ApiOperation)({ summary: 'Upload avatar directly through the server (bypasses CORS)' }),
    (0, swagger_1.ApiConsumes)('multipart/form-data'),
    (0, common_1.UseInterceptors)((0, platform_express_1.FileInterceptor)('file', { limits: { fileSize: 2 * 1024 * 1024 } })),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 5 } }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.UploadedFile)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "uploadAvatarDirect", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, common_1.Delete)('me/avatar'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "deleteAvatar", null);
__decorate([
    (0, common_1.Put)('me/header'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, swagger_1.ApiOperation)({ summary: 'Get presigned URL for header image upload' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, upload_avatar_dto_1.UploadAvatarDto]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "uploadHeader", null);
__decorate([
    (0, common_1.Post)('me/header/confirm'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, swagger_1.ApiOperation)({ summary: 'Confirm header image upload' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, confirm_header_dto_1.ConfirmHeaderDto]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "confirmHeader", null);
__decorate([
    (0, common_1.Post)('me/header/direct'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, swagger_1.ApiOperation)({ summary: 'Upload header image directly through the server (bypasses CORS)' }),
    (0, swagger_1.ApiConsumes)('multipart/form-data'),
    (0, common_1.UseInterceptors)((0, platform_express_1.FileInterceptor)('file', { limits: { fileSize: 5 * 1024 * 1024 } })),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 5 } }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.UploadedFile)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "uploadHeaderDirect", null);
__decorate([
    (0, common_1.Delete)('me/header'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, swagger_1.ApiOperation)({ summary: 'Delete header image' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "deleteHeader", null);
__decorate([
    (0, common_1.Get)('me/links'),
    (0, swagger_1.ApiOperation)({ summary: 'Get my social links' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "getMyLinks", null);
__decorate([
    (0, common_1.Put)('me/links'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, swagger_1.ApiOperation)({ summary: 'Update social links (replaces all)' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, update_links_dto_1.UpdateLinksDto]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "updateLinks", null);
__decorate([
    (0, common_1.Get)('me/blocked'),
    (0, swagger_1.ApiOperation)({ summary: 'List blocked users' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)('page', new common_1.DefaultValuePipe(1), common_1.ParseIntPipe)),
    __param(2, (0, common_1.Query)('limit', new common_1.DefaultValuePipe(20), common_1.ParseIntPipe, new clamp_limit_pipe_1.ClampLimitPipe())),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Number, Number]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "getBlockedUsers", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 86400000, limit: 3 } }),
    (0, common_1.Post)('me/delete-request'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, current_user_decorator_1.CurrentUser)('jti')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, request_account_deletion_dto_1.RequestAccountDeletionDto]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "requestAccountDeletion", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Get)('me/devices'),
    (0, swagger_1.ApiOperation)({ summary: 'List logged-in devices' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)('page', new common_1.DefaultValuePipe(1), common_1.ParseIntPipe)),
    __param(2, (0, common_1.Query)('limit', new common_1.DefaultValuePipe(20), common_1.ParseIntPipe, new clamp_limit_pipe_1.ClampLimitPipe())),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Number, Number]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "getMyDevices", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 20 } }),
    (0, common_1.Delete)('me/devices/:deviceId'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, swagger_1.ApiOperation)({ summary: 'Remove/forget a device' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('deviceId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "removeDevice", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 900000, limit: 10 } }),
    (0, common_1.Patch)('me/devices/:deviceId/trust'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, swagger_1.ApiOperation)({ summary: 'Mark a device as trusted (skip 2FA)' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('deviceId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, trust_device_dto_1.TrustDeviceDto]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "trustDevice", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 900000, limit: 10 } }),
    (0, common_1.Patch)('me/devices/:deviceId/untrust'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, swagger_1.ApiOperation)({ summary: 'Remove trust from a device' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('deviceId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, trust_device_dto_1.TrustDeviceDto]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "untrustDevice", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Get)('me/security-log'),
    (0, swagger_1.ApiOperation)({ summary: 'View security-related activity log' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)('page', new common_1.DefaultValuePipe(1), common_1.ParseIntPipe)),
    __param(2, (0, common_1.Query)('limit', new common_1.DefaultValuePipe(20), common_1.ParseIntPipe, new clamp_limit_pipe_1.ClampLimitPipe())),
    __param(3, (0, common_1.Query)('action', new parse_query_string_pipe_1.ParseQueryStringPipe('action', 50))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Number, Number, String]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "getSecurityLog", null);
__decorate([
    (0, common_1.Get)('me/activity-log'),
    (0, swagger_1.ApiOperation)({ summary: 'View own activity log' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)('page', new common_1.DefaultValuePipe(1), common_1.ParseIntPipe)),
    __param(2, (0, common_1.Query)('limit', new common_1.DefaultValuePipe(20), common_1.ParseIntPipe, new clamp_limit_pipe_1.ClampLimitPipe())),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Number, Number]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "getActivityLog", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 5 } }),
    (0, common_1.Get)('availability'),
    __param(0, (0, common_1.Query)('username')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "checkUsernameAvailability", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Get)('favorites'),
    (0, swagger_1.ApiOperation)({ summary: 'List favorite users' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)('page', new common_1.DefaultValuePipe(1), common_1.ParseIntPipe)),
    __param(2, (0, common_1.Query)('limit', new common_1.DefaultValuePipe(20), common_1.ParseIntPipe, new clamp_limit_pipe_1.ClampLimitPipe())),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Number, Number]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "getFavorites", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Get)('saved'),
    (0, swagger_1.ApiOperation)({ summary: 'List saved profiles' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)('page', new common_1.DefaultValuePipe(1), common_1.ParseIntPipe)),
    __param(2, (0, common_1.Query)('limit', new common_1.DefaultValuePipe(20), common_1.ParseIntPipe, new clamp_limit_pipe_1.ClampLimitPipe())),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Number, Number]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "getSavedProfiles", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, common_1.Get)('search'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)('q', new parse_query_string_pipe_1.ParseQueryStringPipe('q', 200))),
    __param(2, (0, common_1.Query)('page', new common_1.DefaultValuePipe(1), common_1.ParseIntPipe)),
    __param(3, (0, common_1.Query)('limit', new common_1.DefaultValuePipe(10), common_1.ParseIntPipe, new clamp_limit_pipe_1.ClampLimitPipe())),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Number, Number]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "searchUsers", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 15 } }),
    (0, common_1.Get)('discover'),
    (0, swagger_1.ApiOperation)({ summary: 'Search & discover users with filters' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)('q', new parse_query_string_pipe_1.ParseQueryStringPipe('q', 200))),
    __param(2, (0, common_1.Query)('page', new common_1.DefaultValuePipe(1), common_1.ParseIntPipe)),
    __param(3, (0, common_1.Query)('limit', new common_1.DefaultValuePipe(20), common_1.ParseIntPipe, new clamp_limit_pipe_1.ClampLimitPipe())),
    __param(4, (0, common_1.Query)('minRating', new parse_query_string_pipe_1.ParseQueryStringPipe('minRating', 5))),
    __param(5, (0, common_1.Query)('minTransactions', new parse_query_string_pipe_1.ParseQueryStringPipe('minTransactions', 10))),
    __param(6, (0, common_1.Query)('isKycVerified', new parse_query_string_pipe_1.ParseQueryStringPipe('isKycVerified', 5))),
    __param(7, (0, common_1.Query)('membershipRank', new parse_query_string_pipe_1.ParseQueryStringPipe('membershipRank', 20))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Number, Number, String, String, String, String]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "discoverUsers", null);
__decorate([
    (0, common_1.Get)('me/dashboard'),
    (0, swagger_1.ApiOperation)({ summary: 'Get dashboard statistics' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "getDashboardStats", null);
__decorate([
    (0, common_1.Post)('me/showcase/upload'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, swagger_1.ApiOperation)({ summary: 'Upload showcase item image directly' }),
    (0, swagger_1.ApiConsumes)('multipart/form-data'),
    (0, common_1.UseInterceptors)((0, platform_express_1.FileInterceptor)('file', { limits: { fileSize: 5 * 1024 * 1024 } })),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.UploadedFile)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "uploadShowcaseImage", null);
__decorate([
    (0, common_1.Get)('me/showcase'),
    (0, swagger_1.ApiOperation)({ summary: 'Get my showcase items (including inactive)' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "getMyShowcase", null);
__decorate([
    (0, common_1.Post)('me/showcase'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, swagger_1.ApiOperation)({ summary: 'Add a showcase item' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, showcase_dto_1.CreateShowcaseDto]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "createShowcaseItem", null);
__decorate([
    (0, common_1.Put)('me/showcase/:id'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, swagger_1.ApiOperation)({ summary: 'Update a showcase item' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('id', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, showcase_dto_1.UpdateShowcaseDto]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "updateShowcaseItem", null);
__decorate([
    (0, common_1.Delete)('me/showcase/:id'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, swagger_1.ApiOperation)({ summary: 'Delete a showcase item' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('id', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "deleteShowcaseItem", null);
__decorate([
    (0, common_1.Get)('me/questions'),
    (0, swagger_1.ApiOperation)({ summary: 'Get my received or asked questions' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)('type', new common_1.DefaultValuePipe('received'))),
    __param(2, (0, common_1.Query)('page', new common_1.DefaultValuePipe(1), common_1.ParseIntPipe)),
    __param(3, (0, common_1.Query)('limit', new common_1.DefaultValuePipe(20), common_1.ParseIntPipe, new clamp_limit_pipe_1.ClampLimitPipe())),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Number, Number]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "getMyQuestions", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Get)(':username/favorite'),
    (0, swagger_1.ApiOperation)({ summary: 'Check if a user is in favorites' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('username', parse_username_pipe_1.ParseUsernamePipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "checkFavorite", null);
__decorate([
    (0, common_1.Post)(':username/favorite'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, swagger_1.ApiOperation)({ summary: 'Add user to favorites' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('username', parse_username_pipe_1.ParseUsernamePipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "addFavorite", null);
__decorate([
    (0, common_1.Delete)(':username/favorite'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, swagger_1.ApiOperation)({ summary: 'Remove user from favorites' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('username', parse_username_pipe_1.ParseUsernamePipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "removeFavorite", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Get)(':username/saved'),
    (0, swagger_1.ApiOperation)({ summary: 'Check if a profile is saved' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('username', parse_username_pipe_1.ParseUsernamePipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "checkSavedProfile", null);
__decorate([
    (0, common_1.Post)(':username/saved'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, swagger_1.ApiOperation)({ summary: 'Save a profile' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('username', parse_username_pipe_1.ParseUsernamePipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "saveProfile", null);
__decorate([
    (0, common_1.Delete)(':username/saved'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, swagger_1.ApiOperation)({ summary: 'Remove a saved profile' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('username', parse_username_pipe_1.ParseUsernamePipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "removeSavedProfile", null);
__decorate([
    (0, common_1.Post)(':userId/block'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, swagger_1.ApiOperation)({ summary: 'Block a user' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('userId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "blockUser", null);
__decorate([
    (0, common_1.Delete)(':userId/block'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, swagger_1.ApiOperation)({ summary: 'Unblock a user' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('userId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "unblockUser", null);
__decorate([
    (0, common_1.Post)(':userId/report'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 86400000, limit: 5 } }),
    (0, swagger_1.ApiOperation)({ summary: 'Report a user' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('userId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, report_user_dto_1.ReportUserDto]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "reportUser", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Get)(':username'),
    __param(0, (0, common_1.Param)('username', parse_username_pipe_1.ParseUsernamePipe)),
    __param(1, (0, current_user_decorator_1.CurrentUser)('sub')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "getPublicProfile", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Get)(':username/showcase'),
    (0, swagger_1.ApiOperation)({ summary: 'Get public showcase items for a user' }),
    __param(0, (0, common_1.Param)('username', parse_username_pipe_1.ParseUsernamePipe)),
    __param(1, (0, current_user_decorator_1.CurrentUser)('sub')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "getShowcase", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Post)(':username/follow'),
    (0, swagger_1.ApiOperation)({ summary: 'Follow a user' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('username', parse_username_pipe_1.ParseUsernamePipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "followUser", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Delete)(':username/follow'),
    (0, swagger_1.ApiOperation)({ summary: 'Unfollow a user' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('username', parse_username_pipe_1.ParseUsernamePipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "unfollowUser", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 20 } }),
    (0, common_1.Get)(':username/followers'),
    (0, swagger_1.ApiOperation)({ summary: 'List followers of a user' }),
    __param(0, (0, common_1.Param)('username', parse_username_pipe_1.ParseUsernamePipe)),
    __param(1, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(2, (0, common_1.Query)('page', new common_1.DefaultValuePipe(1), common_1.ParseIntPipe)),
    __param(3, (0, common_1.Query)('limit', new common_1.DefaultValuePipe(20), common_1.ParseIntPipe, new clamp_limit_pipe_1.ClampLimitPipe())),
    __param(4, (0, common_1.Query)('search', new parse_query_string_pipe_1.ParseQueryStringPipe('search', 100))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Number, Number, String]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "getFollowers", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 20 } }),
    (0, common_1.Get)(':username/following'),
    (0, swagger_1.ApiOperation)({ summary: 'List users followed by a user' }),
    __param(0, (0, common_1.Param)('username', parse_username_pipe_1.ParseUsernamePipe)),
    __param(1, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(2, (0, common_1.Query)('page', new common_1.DefaultValuePipe(1), common_1.ParseIntPipe)),
    __param(3, (0, common_1.Query)('limit', new common_1.DefaultValuePipe(20), common_1.ParseIntPipe, new clamp_limit_pipe_1.ClampLimitPipe())),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Number, Number]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "getFollowing", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 20 } }),
    (0, common_1.Get)(':username/ratings'),
    __param(0, (0, common_1.Param)('username', parse_username_pipe_1.ParseUsernamePipe)),
    __param(1, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(2, (0, common_1.Query)('page', new common_1.DefaultValuePipe(1), common_1.ParseIntPipe)),
    __param(3, (0, common_1.Query)('limit', new common_1.DefaultValuePipe(10), common_1.ParseIntPipe, new clamp_limit_pipe_1.ClampLimitPipe())),
    __param(4, (0, common_1.Query)('filter', new parse_query_string_pipe_1.ParseQueryStringPipe('filter', 20))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Number, Number, String]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "getUserRatings", null);
__decorate([
    (0, common_1.Post)(':username/questions'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, swagger_1.ApiOperation)({ summary: 'Ask a question on user profile' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('username', parse_username_pipe_1.ParseUsernamePipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, profile_question_dto_1.AskQuestionDto]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "askQuestion", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Get)(':username/questions'),
    (0, swagger_1.ApiOperation)({ summary: 'Get public Q&A for a profile' }),
    __param(0, (0, common_1.Param)('username', parse_username_pipe_1.ParseUsernamePipe)),
    __param(1, (0, common_1.Query)('page', new common_1.DefaultValuePipe(1), common_1.ParseIntPipe)),
    __param(2, (0, common_1.Query)('limit', new common_1.DefaultValuePipe(20), common_1.ParseIntPipe, new clamp_limit_pipe_1.ClampLimitPipe())),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Number, Number]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "getProfileQuestions", null);
__decorate([
    (0, common_1.Put)('questions/:questionId/answer'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, swagger_1.ApiOperation)({ summary: 'Answer a profile question' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('questionId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, profile_question_dto_1.AnswerQuestionDto]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "answerQuestion", null);
__decorate([
    (0, common_1.Delete)('questions/:questionId'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, swagger_1.ApiOperation)({ summary: 'Delete a question' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('questionId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "deleteQuestion", null);
__decorate([
    (0, common_1.Post)('questions/:questionId/comments'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 20 } }),
    (0, swagger_1.ApiOperation)({ summary: 'Add a comment to a Q&A thread' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('questionId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, profile_question_dto_1.AddCommentDto]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "addComment", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Get)('questions/:questionId/comments'),
    (0, swagger_1.ApiOperation)({ summary: 'Get comments for a Q&A thread' }),
    __param(0, (0, common_1.Param)('questionId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, common_1.Query)('page', new common_1.DefaultValuePipe(1), common_1.ParseIntPipe)),
    __param(2, (0, common_1.Query)('limit', new common_1.DefaultValuePipe(20), common_1.ParseIntPipe, new clamp_limit_pipe_1.ClampLimitPipe())),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Number, Number]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "getComments", null);
__decorate([
    (0, common_1.Delete)('comments/:commentId'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, swagger_1.ApiOperation)({ summary: 'Delete a comment' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('commentId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "deleteComment", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Get)(':username/og'),
    (0, swagger_1.ApiOperation)({ summary: 'Get OG metadata for user profile' }),
    __param(0, (0, common_1.Param)('username', parse_username_pipe_1.ParseUsernamePipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "getUserOgMetadata", null);
exports.UsersController = UsersController = __decorate([
    (0, swagger_1.ApiTags)('users'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.Controller)('users'),
    __metadata("design:paramtypes", [users_service_1.UsersService,
        user_search_service_1.UserSearchService,
        user_stats_service_1.UserStatsService,
        user_analytics_service_1.UserAnalyticsService,
        profile_qa_service_1.ProfileQAService,
        og_metadata_service_1.OgMetadataService])
], UsersController);
