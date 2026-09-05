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
exports.ChatController = void 0;
const common_1 = require("@nestjs/common");
const parse_id_pipe_1 = require("../../common/pipes/parse-id.pipe");
const clamp_limit_pipe_1 = require("../../common/pipes/clamp-limit.pipe");
const parse_query_string_pipe_1 = require("../../common/pipes/parse-query-string.pipe");
const platform_express_1 = require("@nestjs/platform-express");
const throttler_1 = require("@nestjs/throttler");
const swagger_1 = require("@nestjs/swagger");
const chat_service_1 = require("./chat.service");
const upload_service_1 = require("../upload/upload.service");
const presigned_url_dto_1 = require("../upload/dto/presigned-url.dto");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const idempotency_decorator_1 = require("../../common/decorators/idempotency.decorator");
const send_message_dto_1 = require("./dto/send-message.dto");
const phone_verified_guard_1 = require("../../common/guards/phone-verified.guard");
const user_throttle_guard_1 = require("../../common/guards/user-throttle.guard");
let ChatController = class ChatController {
    constructor(chatService, uploadService) {
        this.chatService = chatService;
        this.uploadService = uploadService;
    }
    async getRooms(userId, page, limit) {
        return this.chatService.getRooms(userId, page, limit);
    }
    async getMessages(userId, roomId, cursor, limit, excludeIdsRaw) {
        const excludeIds = excludeIdsRaw
            ? excludeIdsRaw.split(',').map(id => id.trim()).filter(id => id.length > 0 && id.length <= 30).slice(0, 200)
            : undefined;
        return this.chatService.getMessages(userId, roomId, cursor, limit, excludeIds);
    }
    async sendMessage(userId, roomId, dto) {
        return this.chatService.sendMessage(userId, roomId, dto);
    }
    async markAsRead(userId, roomId) {
        return this.chatService.markAsRead(userId, roomId);
    }
    async deleteMessage(userId, roomId, messageId) {
        return this.chatService.deleteMessage(userId, roomId, messageId);
    }
    async uploadChatFile(userId, roomId, file) {
        if (!file) {
            throw new common_1.BadRequestException({ code: 'VALIDATION_ERROR', message: 'File is required' });
        }
        await this.chatService.validateRoomAccess(userId, roomId);
        const result = await this.uploadService.uploadDirect(userId, presigned_url_dto_1.UploadPurpose.CHAT_ATTACHMENT, file.originalname, file.mimetype, file.buffer);
        const readableUrl = result.fileUrl.startsWith('https://')
            ? result.fileUrl
            : await this.uploadService.generateDownloadUrl(result.fileKey, 900);
        return { url: readableUrl, fileUrl: readableUrl };
    }
    async getRoomAttachments(userId, roomId, page, limit) {
        return this.chatService.getRoomAttachments(userId, roomId, page, limit);
    }
};
exports.ChatController = ChatController;
__decorate([
    (0, common_1.Get)('rooms'),
    (0, swagger_1.ApiOperation)({ summary: 'List chat rooms for current user' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)('page', new common_1.DefaultValuePipe(1), common_1.ParseIntPipe)),
    __param(2, (0, common_1.Query)('limit', new common_1.DefaultValuePipe(20), common_1.ParseIntPipe, new clamp_limit_pipe_1.ClampLimitPipe())),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Number, Number]),
    __metadata("design:returntype", Promise)
], ChatController.prototype, "getRooms", null);
__decorate([
    (0, common_1.Get)('rooms/:roomId/messages'),
    (0, swagger_1.ApiOperation)({ summary: 'Get messages in a chat room (cursor-based pagination)' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('roomId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Query)('cursor', new parse_query_string_pipe_1.ParseQueryStringPipe('cursor', 100))),
    __param(3, (0, common_1.Query)('limit', new common_1.DefaultValuePipe(50), common_1.ParseIntPipe)),
    __param(4, (0, common_1.Query)('excludeIds')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, Number, String]),
    __metadata("design:returntype", Promise)
], ChatController.prototype, "getMessages", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 60 } }),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.Post)('rooms/:roomId/messages'),
    (0, common_1.HttpCode)(200),
    (0, swagger_1.ApiOperation)({ summary: 'Send a message in a chat room' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('roomId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, send_message_dto_1.SendMessageDto]),
    __metadata("design:returntype", Promise)
], ChatController.prototype, "sendMessage", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 10000, limit: 10 } }),
    (0, common_1.Post)('rooms/:roomId/read'),
    (0, common_1.HttpCode)(200),
    (0, swagger_1.ApiOperation)({ summary: 'Mark messages as read in a chat room' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('roomId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], ChatController.prototype, "markAsRead", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Delete)('rooms/:roomId/messages/:messageId'),
    (0, swagger_1.ApiOperation)({ summary: 'Delete own message in a chat room' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('roomId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Param)('messageId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", Promise)
], ChatController.prototype, "deleteMessage", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.Post)('rooms/:roomId/upload'),
    (0, common_1.HttpCode)(200),
    (0, swagger_1.ApiOperation)({ summary: 'Upload a file attachment to a chat room' }),
    (0, swagger_1.ApiConsumes)('multipart/form-data'),
    (0, common_1.UseInterceptors)((0, platform_express_1.FileInterceptor)('file', { limits: { fileSize: 10 * 1024 * 1024 } })),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('roomId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.UploadedFile)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", Promise)
], ChatController.prototype, "uploadChatFile", null);
__decorate([
    (0, common_1.Get)('rooms/:roomId/attachments'),
    (0, swagger_1.ApiOperation)({ summary: 'List room attachments' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('roomId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Query)('page', new common_1.DefaultValuePipe(1), common_1.ParseIntPipe)),
    __param(3, (0, common_1.Query)('limit', new common_1.DefaultValuePipe(20), common_1.ParseIntPipe, new clamp_limit_pipe_1.ClampLimitPipe())),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Number, Number]),
    __metadata("design:returntype", Promise)
], ChatController.prototype, "getRoomAttachments", null);
exports.ChatController = ChatController = __decorate([
    (0, swagger_1.ApiTags)('chat'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.UseGuards)(phone_verified_guard_1.PhoneVerifiedGuard),
    (0, common_1.Controller)('chat'),
    __metadata("design:paramtypes", [chat_service_1.ChatService,
        upload_service_1.UploadService])
], ChatController);
