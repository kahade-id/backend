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
exports.AdminTicketStatusDto = exports.AdminTicketReplyDto = exports.AdminTicketQueryDto = void 0;
const class_validator_1 = require("class-validator");
const class_transformer_1 = require("class-transformer");
const swagger_1 = require("@nestjs/swagger");
const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'];
const TICKET_CATEGORIES = ['GENERAL', 'ORDER', 'PAYMENT', 'ACCOUNT', 'KYC', 'TECHNICAL', 'OTHER'];
class AdminTicketQueryDto {
}
exports.AdminTicketQueryDto = AdminTicketQueryDto;
__decorate([
    (0, swagger_1.ApiPropertyOptional)(),
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Number),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    __metadata("design:type", Number)
], AdminTicketQueryDto.prototype, "page", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)(),
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Number),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    __metadata("design:type", Number)
], AdminTicketQueryDto.prototype, "limit", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ enum: TICKET_STATUSES }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsIn)(TICKET_STATUSES),
    __metadata("design:type", String)
], AdminTicketQueryDto.prototype, "status", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ enum: TICKET_CATEGORIES }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsIn)(TICKET_CATEGORIES),
    __metadata("design:type", String)
], AdminTicketQueryDto.prototype, "category", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ maxLength: 200 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(200),
    __metadata("design:type", String)
], AdminTicketQueryDto.prototype, "search", void 0);
class AdminTicketReplyDto {
}
exports.AdminTicketReplyDto = AdminTicketReplyDto;
__decorate([
    (0, swagger_1.ApiProperty)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(1),
    (0, class_validator_1.MaxLength)(4000),
    (0, class_validator_1.Matches)(/\S/, { message: 'message cannot be blank' }),
    __metadata("design:type", String)
], AdminTicketReplyDto.prototype, "message", void 0);
class AdminTicketStatusDto {
}
exports.AdminTicketStatusDto = AdminTicketStatusDto;
__decorate([
    (0, swagger_1.ApiProperty)({ enum: TICKET_STATUSES }),
    (0, class_validator_1.IsIn)(TICKET_STATUSES),
    __metadata("design:type", String)
], AdminTicketStatusDto.prototype, "status", void 0);
