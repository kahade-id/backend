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
exports.AdminCampaignsController = void 0;
const common_1 = require("@nestjs/common");
const parse_id_pipe_1 = require("../../../common/pipes/parse-id.pipe");
const parse_query_string_pipe_1 = require("../../../common/pipes/parse-query-string.pipe");
const clamp_limit_pipe_1 = require("../../../common/pipes/clamp-limit.pipe");
const swagger_1 = require("@nestjs/swagger");
const throttler_1 = require("@nestjs/throttler");
const campaign_service_1 = require("../campaign.service");
const current_admin_decorator_1 = require("../../../common/decorators/current-admin.decorator");
const jwt_admin_guard_1 = require("../../../common/guards/jwt-admin.guard");
const admin_roles_guard_1 = require("../../../common/guards/admin-roles.guard");
const admin_roles_decorator_1 = require("../../../common/decorators/admin-roles.decorator");
const public_decorator_1 = require("../../../common/decorators/public.decorator");
const create_campaign_dto_1 = require("./dto/create-campaign.dto");
const update_campaign_dto_1 = require("./dto/update-campaign.dto");
const user_throttle_guard_1 = require("../../../common/guards/user-throttle.guard");
const CAMPAIGN_STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'ENDED'];
let AdminCampaignsController = class AdminCampaignsController {
    constructor(campaignService) {
        this.campaignService = campaignService;
    }
    async createCampaign(adminId, dto, req) {
        return this.campaignService.createCampaign(adminId, {
            ...dto,
            startsAt: new Date(dto.startsAt),
            endsAt: new Date(dto.endsAt),
        }, req.ip || 'unknown');
    }
    async getCampaigns(page, limit, status) {
        return this.campaignService.getCampaigns(page, limit, status);
    }
    async getCampaign(campaignId) {
        return this.campaignService.getCampaign(campaignId);
    }
    async updateCampaign(adminId, campaignId, dto, req) {
        return this.campaignService.updateCampaign(campaignId, adminId, {
            ...dto,
            startsAt: dto.startsAt ? new Date(dto.startsAt) : undefined,
            endsAt: dto.endsAt ? new Date(dto.endsAt) : undefined,
        }, req.ip || 'unknown');
    }
    async deleteCampaign(adminId, campaignId, req) {
        return this.campaignService.deleteCampaign(campaignId, adminId, req.ip || 'unknown');
    }
};
exports.AdminCampaignsController = AdminCampaignsController;
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Post)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, swagger_1.ApiOperation)({ summary: 'Create a campaign' }),
    __param(0, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, create_campaign_dto_1.CreateCampaignDto, Object]),
    __metadata("design:returntype", Promise)
], AdminCampaignsController.prototype, "createCampaign", null);
__decorate([
    (0, common_1.Get)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, swagger_1.ApiOperation)({ summary: 'List campaigns' }),
    __param(0, (0, common_1.Query)('page', new common_1.DefaultValuePipe(1), common_1.ParseIntPipe)),
    __param(1, (0, common_1.Query)('limit', new common_1.DefaultValuePipe(20), new clamp_limit_pipe_1.ClampLimitPipe(100))),
    __param(2, (0, common_1.Query)('status', new parse_query_string_pipe_1.ParseEnumQueryPipe('status', CAMPAIGN_STATUSES))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, Number, String]),
    __metadata("design:returntype", Promise)
], AdminCampaignsController.prototype, "getCampaigns", null);
__decorate([
    (0, common_1.Get)(':campaignId'),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, swagger_1.ApiOperation)({ summary: 'Get campaign details' }),
    __param(0, (0, common_1.Param)('campaignId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AdminCampaignsController.prototype, "getCampaign", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Put)(':campaignId'),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, swagger_1.ApiOperation)({ summary: 'Update a campaign' }),
    __param(0, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(1, (0, common_1.Param)('campaignId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, update_campaign_dto_1.UpdateCampaignDto, Object]),
    __metadata("design:returntype", Promise)
], AdminCampaignsController.prototype, "updateCampaign", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Delete)(':campaignId'),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 5 } }),
    (0, swagger_1.ApiOperation)({ summary: 'Delete a campaign' }),
    __param(0, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(1, (0, common_1.Param)('campaignId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", Promise)
], AdminCampaignsController.prototype, "deleteCampaign", null);
exports.AdminCampaignsController = AdminCampaignsController = __decorate([
    (0, swagger_1.ApiTags)('admin/campaigns'),
    (0, swagger_1.ApiBearerAuth)('admin-token'),
    (0, common_1.UseGuards)(jwt_admin_guard_1.JwtAdminGuard, admin_roles_guard_1.AdminRolesGuard),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN'),
    (0, public_decorator_1.AdminRoute)(),
    (0, common_1.Controller)('admin/campaigns'),
    __metadata("design:paramtypes", [campaign_service_1.CampaignService])
], AdminCampaignsController);
