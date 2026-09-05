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
exports.AdminKycController = void 0;
const public_decorator_1 = require("../../../common/decorators/public.decorator");
const common_1 = require("@nestjs/common");
const parse_id_pipe_1 = require("../../../common/pipes/parse-id.pipe");
const swagger_1 = require("@nestjs/swagger");
const admin_kyc_service_1 = require("./admin-kyc.service");
const kyc_queue_query_dto_1 = require("./dto/kyc-queue-query.dto");
const review_kyc_dto_1 = require("./dto/review-kyc.dto");
const reject_kyc_dto_1 = require("./dto/reject-kyc.dto");
const revoke_kyc_dto_1 = require("./dto/revoke-kyc.dto");
const get_document_urls_dto_1 = require("./dto/get-document-urls.dto");
const jwt_admin_guard_1 = require("../../../common/guards/jwt-admin.guard");
const admin_roles_guard_1 = require("../../../common/guards/admin-roles.guard");
const admin_roles_decorator_1 = require("../../../common/decorators/admin-roles.decorator");
const current_admin_decorator_1 = require("../../../common/decorators/current-admin.decorator");
const user_throttle_guard_1 = require("../../../common/guards/user-throttle.guard");
let AdminKycController = class AdminKycController {
    constructor(service) {
        this.service = service;
    }
    getQueue(query) {
        return this.service.getKycQueue(query.page, query.limit, query.status);
    }
    getDetail(kycId, admin, req) {
        return this.service.getKycDetail(kycId, admin.sub, req.ip || 'unknown');
    }
    getDocumentUrls(kycId, admin, req, dto) {
        return this.service.getDocumentUrls(kycId, admin.sub, req.ip || 'unknown', dto.password);
    }
    approve(kycId, dto, admin, req) {
        return this.service.approveKyc(kycId, admin.sub, dto.notes, req.ip || 'unknown');
    }
    reject(kycId, dto, admin, req) {
        return this.service.rejectKyc(kycId, admin.sub, dto.reason, dto.notes, req.ip || 'unknown');
    }
    revoke(kycId, dto, admin, req) {
        return this.service.revokeKyc(kycId, admin.sub, dto.reason, req.ip || 'unknown');
    }
};
exports.AdminKycController = AdminKycController;
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: 'Get KYC queue', description: 'Paginated KYC request queue ordered FIFO, filterable by status.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'KYC queue returned.' }),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [kyc_queue_query_dto_1.KycQueueQueryDto]),
    __metadata("design:returntype", Promise)
], AdminKycController.prototype, "getQueue", null);
__decorate([
    (0, common_1.Get)(':kycId'),
    (0, swagger_1.ApiOperation)({ summary: 'Get KYC detail', description: 'Returns full KYC request detail including submitted documents.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'KYC detail returned.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'KYC request not found.' }),
    __param(0, (0, common_1.Param)('kycId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, current_admin_decorator_1.CurrentAdmin)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminKycController.prototype, "getDetail", null);
__decorate([
    (0, common_1.Post)(':kycId/document-urls'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, swagger_1.ApiOperation)({ summary: 'Get short-lived signed URLs for KYC documents', description: 'Decrypts stored document keys and returns 5-minute pre-signed S3 download URLs. Requires re-authentication with admin password. KYC_ADMIN and SUPER_ADMIN only.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Signed URLs returned (expires in 300 s).' }),
    (0, swagger_1.ApiResponse)({ status: 401, description: 'Re-authentication failed.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'KYC request not found.' }),
    __param(0, (0, common_1.Param)('kycId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, current_admin_decorator_1.CurrentAdmin)()),
    __param(2, (0, common_1.Req)()),
    __param(3, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, get_document_urls_dto_1.GetDocumentUrlsDto]),
    __metadata("design:returntype", Promise)
], AdminKycController.prototype, "getDocumentUrls", null);
__decorate([
    (0, common_1.Post)(':kycId/approve'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN', 'KYC_ADMIN'),
    (0, swagger_1.ApiOperation)({ summary: 'Approve KYC', description: 'Approves a pending KYC request and sets kycApprovedAt on the user. ADMIN and SUPER_ADMIN only.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'KYC approved — user kycStatus set to APPROVED and kycApprovedAt set.' }),
    (0, swagger_1.ApiResponse)({ status: 400, description: 'KYC is not in PENDING status.' }),
    (0, swagger_1.ApiResponse)({ status: 403, description: 'Insufficient admin role.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'KYC request not found.' }),
    __param(0, (0, common_1.Param)('kycId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, current_admin_decorator_1.CurrentAdmin)()),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, review_kyc_dto_1.ReviewKycDto, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminKycController.prototype, "approve", null);
__decorate([
    (0, common_1.Post)(':kycId/reject'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN', 'KYC_ADMIN'),
    (0, swagger_1.ApiOperation)({ summary: 'Reject KYC', description: 'Rejects a pending KYC request with a mandatory reason. ADMIN and SUPER_ADMIN only.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'KYC rejected.' }),
    (0, swagger_1.ApiResponse)({ status: 400, description: 'KYC is not in PENDING status.' }),
    (0, swagger_1.ApiResponse)({ status: 403, description: 'Insufficient admin role.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'KYC request not found.' }),
    __param(0, (0, common_1.Param)('kycId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, current_admin_decorator_1.CurrentAdmin)()),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, reject_kyc_dto_1.RejectKycDto, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminKycController.prototype, "reject", null);
__decorate([
    (0, common_1.Post)(':kycId/revoke'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN'),
    (0, swagger_1.ApiOperation)({ summary: 'Revoke KYC', description: 'Revokes a previously approved KYC. SUPER_ADMIN only.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'KYC revoked.' }),
    (0, swagger_1.ApiResponse)({ status: 400, description: 'KYC is not in APPROVED status.' }),
    (0, swagger_1.ApiResponse)({ status: 403, description: 'Insufficient admin role.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'KYC request not found.' }),
    __param(0, (0, common_1.Param)('kycId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, current_admin_decorator_1.CurrentAdmin)()),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, revoke_kyc_dto_1.RevokeKycDto, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminKycController.prototype, "revoke", null);
exports.AdminKycController = AdminKycController = __decorate([
    (0, swagger_1.ApiTags)('admin-kyc'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.UseGuards)(jwt_admin_guard_1.JwtAdminGuard, admin_roles_guard_1.AdminRolesGuard),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN', 'KYC_ADMIN'),
    (0, public_decorator_1.AdminRoute)(),
    (0, common_1.Controller)('admin/kyc'),
    __metadata("design:paramtypes", [admin_kyc_service_1.AdminKycService])
], AdminKycController);
