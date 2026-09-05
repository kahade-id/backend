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
exports.FinanceTransactionQueryDto = void 0;
const class_validator_1 = require("class-validator");
const client_1 = require("@prisma/client");
const swagger_1 = require("@nestjs/swagger");
const pagination_dto_1 = require("../../../../common/dto/pagination.dto");
class FinanceTransactionQueryDto extends pagination_dto_1.PaginationDto {
}
exports.FinanceTransactionQueryDto = FinanceTransactionQueryDto;
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ enum: client_1.WalletTransactionType, description: 'Filter by transaction type' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(client_1.WalletTransactionType),
    __metadata("design:type", String)
], FinanceTransactionQueryDto.prototype, "type", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ enum: client_1.WalletTransactionStatus, description: 'Filter by transaction status' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(client_1.WalletTransactionStatus),
    __metadata("design:type", String)
], FinanceTransactionQueryDto.prototype, "status", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Start date in ISO 8601 format (required)' }),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.IsISO8601)(),
    __metadata("design:type", String)
], FinanceTransactionQueryDto.prototype, "startDate", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'End date in ISO 8601 format (required)' }),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.IsISO8601)(),
    __metadata("design:type", String)
], FinanceTransactionQueryDto.prototype, "endDate", void 0);
