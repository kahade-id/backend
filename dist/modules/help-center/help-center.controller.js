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
exports.HelpCenterController = void 0;
const common_1 = require("@nestjs/common");
const parse_id_pipe_1 = require("../../common/pipes/parse-id.pipe");
const parse_slug_pipe_1 = require("../../common/pipes/parse-slug.pipe");
const parse_query_string_pipe_1 = require("../../common/pipes/parse-query-string.pipe");
const swagger_1 = require("@nestjs/swagger");
const throttler_1 = require("@nestjs/throttler");
const help_center_service_1 = require("./help-center.service");
const public_decorator_1 = require("../../common/decorators/public.decorator");
let HelpCenterController = class HelpCenterController {
    constructor(helpCenterService) {
        this.helpCenterService = helpCenterService;
    }
    async getCategories(lang) {
        return this.helpCenterService.getCategories(lang || 'id');
    }
    async getCategoryBySlug(slug, lang) {
        return this.helpCenterService.getCategoryBySlug(slug, lang || 'id');
    }
    async searchFaq(query, lang) {
        return this.helpCenterService.searchFaq(query || '', lang || 'id');
    }
    async trackView(id) {
        return this.helpCenterService.trackView(id);
    }
};
exports.HelpCenterController = HelpCenterController;
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Get)('categories'),
    __param(0, (0, common_1.Query)('lang', new parse_query_string_pipe_1.ParseQueryStringPipe('lang', 5))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], HelpCenterController.prototype, "getCategories", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Get)('categories/:slug'),
    __param(0, (0, common_1.Param)('slug', parse_slug_pipe_1.ParseSlugPipe)),
    __param(1, (0, common_1.Query)('lang', new parse_query_string_pipe_1.ParseQueryStringPipe('lang', 5))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], HelpCenterController.prototype, "getCategoryBySlug", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, common_1.Get)('search'),
    __param(0, (0, common_1.Query)('q', new parse_query_string_pipe_1.ParseQueryStringPipe('q', 100))),
    __param(1, (0, common_1.Query)('lang', new parse_query_string_pipe_1.ParseQueryStringPipe('lang', 5))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], HelpCenterController.prototype, "searchFaq", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Post)('items/:id/view'),
    __param(0, (0, common_1.Param)('id', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], HelpCenterController.prototype, "trackView", null);
exports.HelpCenterController = HelpCenterController = __decorate([
    (0, swagger_1.ApiTags)('help-center'),
    (0, common_1.Controller)('help-center'),
    __metadata("design:paramtypes", [help_center_service_1.HelpCenterService])
], HelpCenterController);
