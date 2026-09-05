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
exports.TransactionTemplatesController = void 0;
const common_1 = require("@nestjs/common");
const parse_id_pipe_1 = require("../../common/pipes/parse-id.pipe");
const swagger_1 = require("@nestjs/swagger");
const throttler_1 = require("@nestjs/throttler");
const transaction_templates_service_1 = require("./transaction-templates.service");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const dto_1 = require("./dto");
const user_throttle_guard_1 = require("../../common/guards/user-throttle.guard");
let TransactionTemplatesController = class TransactionTemplatesController {
    constructor(templatesService) {
        this.templatesService = templatesService;
    }
    async getMyTemplates(userId) {
        return this.templatesService.getMyTemplates(userId);
    }
    async getTemplate(userId, id) {
        return this.templatesService.getTemplate(userId, id);
    }
    async createTemplate(userId, dto) {
        return this.templatesService.createTemplate(userId, dto);
    }
    async updateTemplate(userId, id, dto) {
        return this.templatesService.updateTemplate(userId, id, dto);
    }
    async deleteTemplate(userId, id) {
        return this.templatesService.deleteTemplate(userId, id);
    }
};
exports.TransactionTemplatesController = TransactionTemplatesController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], TransactionTemplatesController.prototype, "getMyTemplates", null);
__decorate([
    (0, common_1.Get)(':id'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('id', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], TransactionTemplatesController.prototype, "getTemplate", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, common_1.Post)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, dto_1.CreateTemplateDto]),
    __metadata("design:returntype", Promise)
], TransactionTemplatesController.prototype, "createTemplate", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, common_1.Put)(':id'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('id', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, dto_1.UpdateTemplateDto]),
    __metadata("design:returntype", Promise)
], TransactionTemplatesController.prototype, "updateTemplate", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 5 } }),
    (0, common_1.Delete)(':id'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('id', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], TransactionTemplatesController.prototype, "deleteTemplate", null);
exports.TransactionTemplatesController = TransactionTemplatesController = __decorate([
    (0, swagger_1.ApiTags)('transaction-templates'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Controller)('transaction-templates'),
    __metadata("design:paramtypes", [transaction_templates_service_1.TransactionTemplatesService])
], TransactionTemplatesController);
