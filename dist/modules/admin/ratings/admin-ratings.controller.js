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
exports.AdminRatingsController = void 0;
const public_decorator_1 = require("../../../common/decorators/public.decorator");
const common_1 = require("@nestjs/common");
const parse_id_pipe_1 = require("../../../common/pipes/parse-id.pipe");
const swagger_1 = require("@nestjs/swagger");
const admin_ratings_service_1 = require("./admin-ratings.service");
const rating_list_query_dto_1 = require("./dto/rating-list-query.dto");
const rating_action_dto_1 = require("./dto/rating-action.dto");
const jwt_admin_guard_1 = require("../../../common/guards/jwt-admin.guard");
const admin_roles_guard_1 = require("../../../common/guards/admin-roles.guard");
const admin_roles_decorator_1 = require("../../../common/decorators/admin-roles.decorator");
const current_admin_decorator_1 = require("../../../common/decorators/current-admin.decorator");
const user_throttle_guard_1 = require("../../../common/guards/user-throttle.guard");
let AdminRatingsController = class AdminRatingsController {
    constructor(service) {
        this.service = service;
    }
    listRatings(query) {
        return this.service.listRatings(query.page, query.limit, query.stars, query.flagged);
    }
    removeRating(ratingId, adminId, req, dto) {
        return this.service.removeRating(ratingId, adminId, req.ip ?? '', dto.reason);
    }
    unhideRating(ratingId, adminId, req, dto) {
        return this.service.unhideRating(ratingId, adminId, req.ip ?? '', dto.reason);
    }
};
exports.AdminRatingsController = AdminRatingsController;
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: 'List all ratings' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Ratings list returned.' }),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [rating_list_query_dto_1.RatingListQueryDto]),
    __metadata("design:returntype", Promise)
], AdminRatingsController.prototype, "listRatings", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Delete)(':ratingId'),
    (0, swagger_1.ApiOperation)({ summary: 'Hide (soft-remove) inappropriate rating' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Rating hidden.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Rating not found.' }),
    __param(0, (0, common_1.Param)('ratingId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(2, (0, common_1.Req)()),
    __param(3, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, rating_action_dto_1.RatingActionDto]),
    __metadata("design:returntype", Promise)
], AdminRatingsController.prototype, "removeRating", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Patch)(':ratingId/unhide'),
    (0, swagger_1.ApiOperation)({ summary: 'Unhide a previously hidden rating' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Rating unhidden.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Rating not found.' }),
    __param(0, (0, common_1.Param)('ratingId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(2, (0, common_1.Req)()),
    __param(3, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, rating_action_dto_1.RatingActionDto]),
    __metadata("design:returntype", Promise)
], AdminRatingsController.prototype, "unhideRating", null);
exports.AdminRatingsController = AdminRatingsController = __decorate([
    (0, swagger_1.ApiTags)('admin-ratings'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.UseGuards)(jwt_admin_guard_1.JwtAdminGuard, admin_roles_guard_1.AdminRolesGuard),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN', 'CUSTOMER_SUPPORT'),
    (0, public_decorator_1.AdminRoute)(),
    (0, common_1.Controller)('admin/ratings'),
    __metadata("design:paramtypes", [admin_ratings_service_1.AdminRatingsService])
], AdminRatingsController);
