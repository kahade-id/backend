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
exports.SupportController = void 0;
const common_1 = require("@nestjs/common");
const parse_id_pipe_1 = require("../../common/pipes/parse-id.pipe");
const clamp_limit_pipe_1 = require("../../common/pipes/clamp-limit.pipe");
const swagger_1 = require("@nestjs/swagger");
const throttler_1 = require("@nestjs/throttler");
const support_service_1 = require("./support.service");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const create_ticket_dto_1 = require("./dto/create-ticket.dto");
const user_throttle_guard_1 = require("../../common/guards/user-throttle.guard");
let SupportController = class SupportController {
    constructor(supportService) {
        this.supportService = supportService;
    }
    async getTickets(userId, page, limit) {
        return this.supportService.getTickets(userId, page, limit);
    }
    async createTicket(userId, dto) {
        return this.supportService.createTicket(userId, dto);
    }
    async getTicketDetail(userId, ticketId) {
        return this.supportService.getTicketDetail(userId, ticketId);
    }
    async replyToTicket(userId, ticketId, dto) {
        return this.supportService.replyToTicket(userId, ticketId, dto);
    }
};
exports.SupportController = SupportController;
__decorate([
    (0, common_1.Get)('tickets'),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, swagger_1.ApiOperation)({ summary: 'List my support tickets' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)('page', new common_1.DefaultValuePipe(1), common_1.ParseIntPipe)),
    __param(2, (0, common_1.Query)('limit', new common_1.DefaultValuePipe(20), common_1.ParseIntPipe, new clamp_limit_pipe_1.ClampLimitPipe(50))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Number, Number]),
    __metadata("design:returntype", Promise)
], SupportController.prototype, "getTickets", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Post)('tickets'),
    (0, throttler_1.Throttle)({ default: { ttl: 3600000, limit: 10 } }),
    (0, swagger_1.ApiOperation)({ summary: 'Create a support ticket' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, create_ticket_dto_1.CreateTicketDto]),
    __metadata("design:returntype", Promise)
], SupportController.prototype, "createTicket", null);
__decorate([
    (0, common_1.Get)('tickets/:ticketId'),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, swagger_1.ApiOperation)({ summary: 'Get ticket detail' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('ticketId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], SupportController.prototype, "getTicketDetail", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Post)('tickets/:ticketId/reply'),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, swagger_1.ApiOperation)({ summary: 'Reply to a ticket' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('ticketId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, create_ticket_dto_1.ReplyTicketDto]),
    __metadata("design:returntype", Promise)
], SupportController.prototype, "replyToTicket", null);
exports.SupportController = SupportController = __decorate([
    (0, swagger_1.ApiTags)('support'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.Controller)('support'),
    __metadata("design:paramtypes", [support_service_1.SupportService])
], SupportController);
