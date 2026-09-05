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
exports.UploadController = void 0;
const common_1 = require("@nestjs/common");
const platform_express_1 = require("@nestjs/platform-express");
const swagger_1 = require("@nestjs/swagger");
const throttler_1 = require("@nestjs/throttler");
const class_validator_1 = require("class-validator");
const phone_verified_guard_1 = require("../../common/guards/phone-verified.guard");
const user_throttle_guard_1 = require("../../common/guards/user-throttle.guard");
const upload_service_1 = require("./upload.service");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const presigned_url_dto_1 = require("./dto/presigned-url.dto");
const confirm_upload_dto_1 = require("./dto/confirm-upload.dto");
class CleanupFilesDto {
}
__decorate([
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ArrayMinSize)(1),
    (0, class_validator_1.ArrayMaxSize)(20),
    (0, class_validator_1.IsString)({ each: true }),
    __metadata("design:type", Array)
], CleanupFilesDto.prototype, "fileKeys", void 0);
let UploadController = class UploadController {
    constructor(uploadService) {
        this.uploadService = uploadService;
    }
    async getPresignedUrl(userId, dto) {
        return this.uploadService.generatePresignedUrl(userId, dto.purpose, dto.fileName, dto.contentType, dto.fileSize);
    }
    async confirmUpload(userId, dto) {
        return this.uploadService.confirmUpload(userId, dto.fileKey, dto.sha256);
    }
    async uploadDirect(userId, file, purpose) {
        if (!file) {
            throw new common_1.BadRequestException({ code: 'VALIDATION_ERROR', message: 'File is required' });
        }
        if (!purpose || !Object.values(presigned_url_dto_1.UploadPurpose).includes(purpose)) {
            throw new common_1.BadRequestException({
                code: 'VALIDATION_ERROR',
                message: `Invalid purpose. Must be one of: ${Object.values(presigned_url_dto_1.UploadPurpose).join(', ')}`,
            });
        }
        return this.uploadService.uploadDirect(userId, purpose, file.originalname, file.mimetype, file.buffer);
    }
    async cleanupFiles(userId, dto) {
        return this.uploadService.cleanupFileKeys(userId, dto.fileKeys);
    }
};
exports.UploadController = UploadController;
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Post)('presigned-url'),
    (0, swagger_1.ApiOperation)({ summary: 'Generate pre-signed upload URL' }),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, presigned_url_dto_1.PresignedUrlDto]),
    __metadata("design:returntype", Promise)
], UploadController.prototype, "getPresignedUrl", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Post)('confirm'),
    (0, swagger_1.ApiOperation)({ summary: 'Confirm file upload was completed' }),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 20 } }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, confirm_upload_dto_1.ConfirmUploadDto]),
    __metadata("design:returntype", Promise)
], UploadController.prototype, "confirmUpload", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Post)('direct'),
    (0, swagger_1.ApiOperation)({ summary: 'Upload file directly through the server (bypasses CORS)' }),
    (0, swagger_1.ApiConsumes)('multipart/form-data'),
    (0, swagger_1.ApiBody)({
        schema: {
            type: 'object',
            required: ['file', 'purpose'],
            properties: {
                file: { type: 'string', format: 'binary' },
                purpose: { type: 'string', enum: Object.values(presigned_url_dto_1.UploadPurpose) },
            },
        },
    }),
    (0, common_1.UseInterceptors)((0, platform_express_1.FileInterceptor)('file', { limits: { fileSize: 10 * 1024 * 1024 } })),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.UploadedFile)()),
    __param(2, (0, common_1.Body)('purpose')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, String]),
    __metadata("design:returntype", Promise)
], UploadController.prototype, "uploadDirect", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Post)('cleanup'),
    (0, common_1.HttpCode)(200),
    (0, swagger_1.ApiOperation)({ summary: 'Delete previously uploaded files (rollback partial uploads)' }),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 5 } }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, CleanupFilesDto]),
    __metadata("design:returntype", Promise)
], UploadController.prototype, "cleanupFiles", null);
exports.UploadController = UploadController = __decorate([
    (0, swagger_1.ApiTags)('upload'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.UseGuards)(phone_verified_guard_1.PhoneVerifiedGuard),
    (0, common_1.Controller)('upload'),
    __metadata("design:paramtypes", [upload_service_1.UploadService])
], UploadController);
