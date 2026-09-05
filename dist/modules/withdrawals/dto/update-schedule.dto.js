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
Object.defineProperty(exports, "__esModule", { value: true });
exports.UpdateScheduleDto = void 0;
const class_validator_1 = require("class-validator");
const swagger_1 = require("@nestjs/swagger");
const is_valid_id_decorator_1 = require("../../../common/decorators/is-valid-id.decorator");
class UpdateScheduleDto {
}
exports.UpdateScheduleDto = UpdateScheduleDto;
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Day of week (0=Sunday, 6=Saturday)', minimum: 0, maximum: 6 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(0),
    (0, class_validator_1.Max)(6),
    __metadata("design:type", Number)
], UpdateScheduleDto.prototype, "dayOfWeek", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Minimum balance to trigger withdrawal', minimum: 1 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(100_000_000),
    __metadata("design:type", Number)
], UpdateScheduleDto.prototype, "minAmount", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Whether the schedule is active' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], UpdateScheduleDto.prototype, "isActive", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Bank account ID to withdraw to' }),
    (0, class_validator_1.IsOptional)(),
    (0, is_valid_id_decorator_1.IsValidId)(),
    __metadata("design:type", String)
], UpdateScheduleDto.prototype, "bankAccountId", void 0);
