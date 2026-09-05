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
exports.SearchController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const search_service_1 = require("./search.service");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const user_throttle_guard_1 = require("../../common/guards/user-throttle.guard");
const throttler_1 = require("@nestjs/throttler");
const parse_query_string_pipe_1 = require("../../common/pipes/parse-query-string.pipe");
const ALLOWED_SEARCH_TYPES = new Set(['users', 'orders', 'transactions']);
function parseLimit(value, fallback, max) {
    if (value === undefined || value.trim() === '')
        return fallback;
    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) {
        throw new common_1.BadRequestException({ code: 'SEARCH_INVALID_LIMIT', message: 'Search limit must be a whole number' });
    }
    const parsed = Number(normalized);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
        throw new common_1.BadRequestException({ code: 'SEARCH_INVALID_LIMIT', message: `Search limit must be between 1 and ${max}` });
    }
    return parsed;
}
let SearchController = class SearchController {
    constructor(searchService) {
        this.searchService = searchService;
    }
    async search(userId, query, types, limitParam) {
        const q = (query || '').trim();
        if (q.length > 0 && q.length < 2) {
            throw new common_1.BadRequestException({ code: 'SEARCH_QUERY_TOO_SHORT', message: 'Search query must be at least 2 characters' });
        }
        const limit = parseLimit(limitParam, 5, 50);
        let typeArray;
        if (types !== undefined) {
            const requestedTypes = types.split(',').map((t) => t.trim()).filter(Boolean);
            if (requestedTypes.length === 0 || requestedTypes.some((type) => !ALLOWED_SEARCH_TYPES.has(type))) {
                throw new common_1.BadRequestException({ code: 'SEARCH_INVALID_TYPES', message: 'Invalid search types' });
            }
            typeArray = Array.from(new Set(requestedTypes));
        }
        return this.searchService.search(userId, q, typeArray, limit);
    }
    async suggestions(userId, query, limitParam) {
        const q = (query || '').trim();
        if (q.length > 0 && q.length < 2) {
            return { suggestions: [] };
        }
        const limit = parseLimit(limitParam, 6, 20);
        return this.searchService.suggestions(userId, q, limit);
    }
};
exports.SearchController = SearchController;
__decorate([
    (0, common_1.Get)(),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, swagger_1.ApiOperation)({ summary: 'Global search across users, orders, and transactions' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)('q', new parse_query_string_pipe_1.ParseQueryStringPipe('q', 200))),
    __param(2, (0, common_1.Query)('types', new parse_query_string_pipe_1.ParseQueryStringPipe('types', 100))),
    __param(3, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String]),
    __metadata("design:returntype", Promise)
], SearchController.prototype, "search", null);
__decorate([
    (0, common_1.Get)('suggestions'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 60 } }),
    (0, swagger_1.ApiOperation)({ summary: 'Get search autocomplete suggestions' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)('q', new parse_query_string_pipe_1.ParseQueryStringPipe('q', 200))),
    __param(2, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", Promise)
], SearchController.prototype, "suggestions", null);
exports.SearchController = SearchController = __decorate([
    (0, swagger_1.ApiTags)('Search'),
    (0, swagger_1.ApiBearerAuth)(),
    (0, common_1.Controller)('search'),
    __metadata("design:paramtypes", [search_service_1.SearchService])
], SearchController);
