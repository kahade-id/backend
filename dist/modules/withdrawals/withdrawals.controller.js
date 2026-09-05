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
exports.WithdrawalsController = void 0;
const common_1 = require("@nestjs/common");
const parse_id_pipe_1 = require("../../common/pipes/parse-id.pipe");
const swagger_1 = require("@nestjs/swagger");
const throttler_1 = require("@nestjs/throttler");
const scheduled_withdrawal_service_1 = require("./scheduled-withdrawal.service");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const create_schedule_dto_1 = require("./dto/create-schedule.dto");
const update_schedule_dto_1 = require("./dto/update-schedule.dto");
const user_throttle_guard_1 = require("../../common/guards/user-throttle.guard");
const idempotency_decorator_1 = require("../../common/decorators/idempotency.decorator");
let WithdrawalsController = class WithdrawalsController {
    constructor(scheduledWithdrawalService) {
        this.scheduledWithdrawalService = scheduledWithdrawalService;
    }
    async createSchedule(userId, dto) {
        return this.scheduledWithdrawalService.createSchedule(userId, dto);
    }
    async getSchedules(userId) {
        return this.scheduledWithdrawalService.getSchedules(userId);
    }
    async updateSchedule(userId, scheduleId, dto) {
        return this.scheduledWithdrawalService.updateSchedule(userId, scheduleId, dto);
    }
    async deleteSchedule(userId, scheduleId) {
        return this.scheduledWithdrawalService.deleteSchedule(userId, scheduleId);
    }
};
exports.WithdrawalsController = WithdrawalsController;
__decorate([
    (0, common_1.Post)('schedules'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, throttler_1.Throttle)({ default: { ttl: 3600000, limit: 10 } }),
    (0, swagger_1.ApiOperation)({ summary: 'Create a scheduled withdrawal' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, create_schedule_dto_1.CreateScheduleDto]),
    __metadata("design:returntype", Promise)
], WithdrawalsController.prototype, "createSchedule", null);
__decorate([
    (0, common_1.Get)('schedules'),
    (0, swagger_1.ApiOperation)({ summary: 'Get my scheduled withdrawals' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], WithdrawalsController.prototype, "getSchedules", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 3600000, limit: 10 } }),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.Put)('schedules/:scheduleId'),
    (0, swagger_1.ApiOperation)({ summary: 'Update a scheduled withdrawal' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('scheduleId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, update_schedule_dto_1.UpdateScheduleDto]),
    __metadata("design:returntype", Promise)
], WithdrawalsController.prototype, "updateSchedule", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 3600000, limit: 10 } }),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.Delete)('schedules/:scheduleId'),
    (0, swagger_1.ApiOperation)({ summary: 'Deactivate a scheduled withdrawal' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('scheduleId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], WithdrawalsController.prototype, "deleteSchedule", null);
exports.WithdrawalsController = WithdrawalsController = __decorate([
    (0, swagger_1.ApiTags)('withdrawals'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.Controller)('withdrawals'),
    __metadata("design:paramtypes", [scheduled_withdrawal_service_1.ScheduledWithdrawalService])
], WithdrawalsController);
