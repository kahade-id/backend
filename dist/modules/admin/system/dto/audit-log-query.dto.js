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
exports.WebhookLogQueryDto = exports.AuditLogQueryDto = void 0;
const class_validator_1 = require("class-validator");
const swagger_1 = require("@nestjs/swagger");
const pagination_dto_1 = require("../../../../common/dto/pagination.dto");
class AuditLogQueryDto extends pagination_dto_1.PaginationDto {
}
exports.AuditLogQueryDto = AuditLogQueryDto;
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Filter by action type' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], AuditLogQueryDto.prototype, "action", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Filter by admin ID' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], AuditLogQueryDto.prototype, "adminId", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Filter by target resource type (e.g. USER, ORDER, KYC)' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], AuditLogQueryDto.prototype, "targetType", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Start date in ISO 8601 format' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsDateString)(),
    __metadata("design:type", String)
], AuditLogQueryDto.prototype, "startDate", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'End date in ISO 8601 format' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsDateString)(),
    __metadata("design:type", String)
], AuditLogQueryDto.prototype, "endDate", void 0);
class WebhookLogQueryDto extends pagination_dto_1.PaginationDto {
}
exports.WebhookLogQueryDto = WebhookLogQueryDto;
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Filter by webhook source' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], WebhookLogQueryDto.prototype, "source", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Filter by processed status' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], WebhookLogQueryDto.prototype, "isProcessed", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Filter dead-letter state' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], WebhookLogQueryDto.prototype, "deadLettered", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Full-text search across source, event, and errorMessage fields' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], WebhookLogQueryDto.prototype, "search", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Filter logs received on or after this date (ISO 8601)' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsDateString)(),
    __metadata("design:type", String)
], WebhookLogQueryDto.prototype, "startDate", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Filter logs received on or before this date (ISO 8601)' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsDateString)(),
    __metadata("design:type", String)
], WebhookLogQueryDto.prototype, "endDate", void 0);
