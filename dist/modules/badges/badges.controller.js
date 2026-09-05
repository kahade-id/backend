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
exports.BadgesController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const throttler_1 = require("@nestjs/throttler");
const badges_service_1 = require("./badges.service");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const pagination_dto_1 = require("../../common/dto/pagination.dto");
let BadgesController = class BadgesController {
    constructor(badgesService) {
        this.badgesService = badgesService;
    }
    listBadges(userId, pagination) {
        return this.badgesService.listAllBadges(userId, pagination.page ?? 1, pagination.limit ?? 20);
    }
    getMyBadges(userId, pagination) {
        return this.badgesService.getMyBadges(userId, pagination.page ?? 1, pagination.limit ?? 50);
    }
};
exports.BadgesController = BadgesController;
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: 'List all available badges' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'All badges returned.' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, pagination_dto_1.PaginationDto]),
    __metadata("design:returntype", void 0)
], BadgesController.prototype, "listBadges", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Get)('my'),
    (0, swagger_1.ApiOperation)({ summary: 'List current user earned badges (paginated)' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'User badges returned.' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, pagination_dto_1.PaginationDto]),
    __metadata("design:returntype", Promise)
], BadgesController.prototype, "getMyBadges", null);
exports.BadgesController = BadgesController = __decorate([
    (0, swagger_1.ApiTags)('badges'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.Controller)('badges'),
    __metadata("design:paramtypes", [badges_service_1.BadgesService])
], BadgesController);
