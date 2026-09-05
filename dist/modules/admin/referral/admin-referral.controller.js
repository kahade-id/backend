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
exports.AdminReferralController = void 0;
const public_decorator_1 = require("../../../common/decorators/public.decorator");
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const admin_referral_service_1 = require("./admin-referral.service");
const referral_code_query_dto_1 = require("./dto/referral-code-query.dto");
const jwt_admin_guard_1 = require("../../../common/guards/jwt-admin.guard");
const admin_roles_guard_1 = require("../../../common/guards/admin-roles.guard");
const admin_roles_decorator_1 = require("../../../common/decorators/admin-roles.decorator");
let AdminReferralController = class AdminReferralController {
    constructor(service) {
        this.service = service;
    }
    getReferralStats() {
        return this.service.getReferralStats();
    }
    listReferralCodes(query) {
        return this.service.listReferralCodes(query.page, query.limit, query.isActive);
    }
};
exports.AdminReferralController = AdminReferralController;
__decorate([
    (0, common_1.Get)('stats'),
    (0, swagger_1.ApiOperation)({ summary: 'Platform referral statistics' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Referral stats returned.' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AdminReferralController.prototype, "getReferralStats", null);
__decorate([
    (0, common_1.Get)('codes'),
    (0, swagger_1.ApiOperation)({ summary: 'List all referral codes' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Referral codes list returned.' }),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [referral_code_query_dto_1.ReferralCodeQueryDto]),
    __metadata("design:returntype", Promise)
], AdminReferralController.prototype, "listReferralCodes", null);
exports.AdminReferralController = AdminReferralController = __decorate([
    (0, swagger_1.ApiTags)('admin-referral'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.UseGuards)(jwt_admin_guard_1.JwtAdminGuard, admin_roles_guard_1.AdminRolesGuard),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN', 'FINANCE_ADMIN'),
    (0, public_decorator_1.AdminRoute)(),
    (0, common_1.Controller)('admin/referral'),
    __metadata("design:paramtypes", [admin_referral_service_1.AdminReferralService])
], AdminReferralController);
