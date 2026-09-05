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
exports.KycController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const throttler_1 = require("@nestjs/throttler");
const kyc_service_1 = require("./kyc.service");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const idempotency_decorator_1 = require("../../common/decorators/idempotency.decorator");
const user_throttle_guard_1 = require("../../common/guards/user-throttle.guard");
const submit_kyc_dto_1 = require("./dto/submit-kyc.dto");
const pagination_dto_1 = require("../../common/dto/pagination.dto");
let KycController = class KycController {
    constructor(kycService) {
        this.kycService = kycService;
    }
    async submit(userId, dto, req) {
        const ipAddress = req.ip;
        this.validateKycFileOwnership(userId, dto.ktpFileKey, dto.selfieFileKey);
        return this.kycService.submit(userId, dto.ktpFileKey, dto.selfieFileKey, dto.nik, ipAddress);
    }
    async getStatus(userId) {
        return this.kycService.getStatus(userId);
    }
    async getHistory(userId, pagination) {
        return this.kycService.getHistory(userId, pagination.page ?? 1, pagination.limit ?? 20);
    }
    async resubmit(userId, dto, req) {
        const ipAddress = req.ip;
        this.validateKycFileOwnership(userId, dto.ktpFileKey, dto.selfieFileKey);
        return this.kycService.resubmit(userId, dto.ktpFileKey, dto.selfieFileKey, dto.nik, ipAddress);
    }
    validateKycFileOwnership(userId, ktpFileKey, selfieFileKey) {
        const ktpPrefix = `uploads/kyc-ktp/${userId}/`;
        const selfiePrefix = `uploads/kyc-selfie/${userId}/`;
        if (!ktpFileKey.startsWith(ktpPrefix) || !selfieFileKey.startsWith(selfiePrefix)) {
            throw new common_1.BadRequestException({
                code: 'FILE_ACCESS_DENIED',
                message: 'File key does not belong to this user',
            });
        }
    }
};
exports.KycController = KycController;
__decorate([
    (0, common_1.Post)('submit'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 3 } }),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, swagger_1.ApiOperation)({ summary: 'Submit KYC request (gunakan fileKey dari /upload/confirm)' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, submit_kyc_dto_1.SubmitKycDto, Object]),
    __metadata("design:returntype", Promise)
], KycController.prototype, "submit", null);
__decorate([
    (0, common_1.Get)('status'),
    (0, swagger_1.ApiOperation)({ summary: 'Get current KYC status' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], KycController.prototype, "getStatus", null);
__decorate([
    (0, common_1.Get)('history'),
    (0, swagger_1.ApiOperation)({ summary: 'List all KYC requests (paginated)' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, pagination_dto_1.PaginationDto]),
    __metadata("design:returntype", Promise)
], KycController.prototype, "getHistory", null);
__decorate([
    (0, common_1.Post)('resubmit'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 3 } }),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, swagger_1.ApiOperation)({ summary: 'Resubmit KYC after rejection (gunakan fileKey dari /upload/confirm)' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, submit_kyc_dto_1.SubmitKycDto, Object]),
    __metadata("design:returntype", Promise)
], KycController.prototype, "resubmit", null);
exports.KycController = KycController = __decorate([
    (0, swagger_1.ApiTags)('kyc'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.Controller)('kyc'),
    __metadata("design:paramtypes", [kyc_service_1.KycService])
], KycController);
