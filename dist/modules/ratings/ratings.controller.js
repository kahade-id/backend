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
exports.RatingsController = exports.RatingReplyDto = void 0;
const common_1 = require("@nestjs/common");
const parse_id_pipe_1 = require("../../common/pipes/parse-id.pipe");
const swagger_1 = require("@nestjs/swagger");
const throttler_1 = require("@nestjs/throttler");
const class_validator_1 = require("class-validator");
const ratings_service_1 = require("./ratings.service");
const rating_reply_service_1 = require("./rating-reply.service");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const create_rating_dto_1 = require("./dto/create-rating.dto");
const update_rating_dto_1 = require("./dto/update-rating.dto");
const pagination_dto_1 = require("../../common/dto/pagination.dto");
const user_throttle_guard_1 = require("../../common/guards/user-throttle.guard");
const idempotency_decorator_1 = require("../../common/decorators/idempotency.decorator");
class RatingReplyDto {
}
exports.RatingReplyDto = RatingReplyDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Reply content', maxLength: 500 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.MaxLength)(500),
    __metadata("design:type", String)
], RatingReplyDto.prototype, "content", void 0);
let RatingsController = class RatingsController {
    constructor(ratingsService, ratingReplyService) {
        this.ratingsService = ratingsService;
        this.ratingReplyService = ratingReplyService;
    }
    async createRating(userId, dto) {
        return this.ratingsService.createRating(userId, dto);
    }
    async getMyRatings(userId, pagination) {
        return this.ratingsService.getMyRatings(userId, pagination.page ?? 1, pagination.limit ?? 20);
    }
    async updateRating(userId, ratingId, dto) {
        return this.ratingsService.updateRating(userId, ratingId, dto);
    }
    async replyToRating(userId, ratingId, dto) {
        return this.ratingReplyService.createReply(userId, ratingId, dto.content);
    }
    async updateReply(userId, replyId, dto) {
        return this.ratingReplyService.updateReply(userId, replyId, dto.content);
    }
    async deleteReply(userId, replyId) {
        return this.ratingReplyService.deleteReply(userId, replyId);
    }
};
exports.RatingsController = RatingsController;
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 5 } }),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.Post)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, create_rating_dto_1.CreateRatingDto]),
    __metadata("design:returntype", Promise)
], RatingsController.prototype, "createRating", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Get)('my'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, pagination_dto_1.PaginationDto]),
    __metadata("design:returntype", Promise)
], RatingsController.prototype, "getMyRatings", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.Put)(':ratingId'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('ratingId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, update_rating_dto_1.UpdateRatingDto]),
    __metadata("design:returntype", Promise)
], RatingsController.prototype, "updateRating", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Post)(':ratingId/reply'),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 5 } }),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, swagger_1.ApiOperation)({ summary: 'Reply to a rating' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('ratingId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, RatingReplyDto]),
    __metadata("design:returntype", Promise)
], RatingsController.prototype, "replyToRating", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Put)('replies/:replyId'),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, swagger_1.ApiOperation)({ summary: 'Update a reply' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('replyId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, RatingReplyDto]),
    __metadata("design:returntype", Promise)
], RatingsController.prototype, "updateReply", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.Delete)('replies/:replyId'),
    (0, swagger_1.ApiOperation)({ summary: 'Delete a reply' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('replyId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], RatingsController.prototype, "deleteReply", null);
exports.RatingsController = RatingsController = __decorate([
    (0, swagger_1.ApiTags)('ratings'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.Controller)('ratings'),
    __metadata("design:paramtypes", [ratings_service_1.RatingsService,
        rating_reply_service_1.RatingReplyService])
], RatingsController);
