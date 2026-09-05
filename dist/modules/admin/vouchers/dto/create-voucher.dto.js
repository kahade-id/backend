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
exports.CreateVoucherDto = void 0;
const class_validator_1 = require("class-validator");
const client_1 = require("@prisma/client");
const class_transformer_1 = require("class-transformer");
const swagger_1 = require("@nestjs/swagger");
const class_validator_2 = require("class-validator");
class CreateVoucherDto {
}
exports.CreateVoucherDto = CreateVoucherDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Voucher code (A-Z, 0-9, underscore, or hyphen)', maxLength: 30 }),
    (0, class_transformer_1.Transform)(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value)),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.MaxLength)(30),
    (0, class_validator_2.Matches)(/^[A-Z0-9_-]+$/, { message: 'code may contain only A-Z, 0-9, underscore, or hyphen' }),
    __metadata("design:type", String)
], CreateVoucherDto.prototype, "code", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Voucher name', maxLength: 100 }),
    (0, class_transformer_1.Transform)(({ value }) => (typeof value === 'string' ? value.trim() : value)),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.MaxLength)(100),
    __metadata("design:type", String)
], CreateVoucherDto.prototype, "name", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Voucher description', maxLength: 500 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Transform)(({ value }) => (typeof value === 'string' ? value.trim() : value)),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(500),
    __metadata("design:type", String)
], CreateVoucherDto.prototype, "description", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ enum: client_1.VoucherType, description: 'Type of voucher' }),
    (0, class_validator_1.IsEnum)(client_1.VoucherType),
    __metadata("design:type", String)
], CreateVoucherDto.prototype, "voucherType", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Discount amount in IDR', minimum: 1, maximum: 50_000_000 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Number),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(50_000_000, { message: 'discountAmount cannot exceed Rp 50.000.000' }),
    __metadata("design:type", Number)
], CreateVoucherDto.prototype, "discountAmount", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({
        description: 'Discount percentage (0.01–100)',
        minimum: 0.01,
        maximum: 100,
    }),
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Number),
    (0, class_validator_1.Min)(0.01),
    (0, class_validator_1.Max)(100),
    __metadata("design:type", Number)
], CreateVoucherDto.prototype, "discountPercent", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({
        description: 'Maximum discount amount in IDR',
        minimum: 1,
        maximum: 50_000_000,
    }),
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Number),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(50_000_000, { message: 'maxDiscountAmount cannot exceed Rp 50.000.000' }),
    __metadata("design:type", Number)
], CreateVoucherDto.prototype, "maxDiscountAmount", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Maximum total usage count', minimum: 1, maximum: 1_000_000 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Number),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(1_000_000),
    __metadata("design:type", Number)
], CreateVoucherDto.prototype, "maxUsageTotal", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Maximum usage per user', minimum: 1, maximum: 10_000 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Number),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(10_000),
    __metadata("design:type", Number)
], CreateVoucherDto.prototype, "maxUsagePerUser", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Valid from date in ISO 8601 format' }),
    (0, class_validator_1.IsDateString)(),
    __metadata("design:type", String)
], CreateVoucherDto.prototype, "validFrom", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Valid until date in ISO 8601 format' }),
    (0, class_validator_1.IsDateString)(),
    __metadata("design:type", String)
], CreateVoucherDto.prototype, "validUntil", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({
        description: 'Minimum order value in IDR',
        minimum: 0,
        maximum: 1_000_000_000,
    }),
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Number),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(0),
    (0, class_validator_1.Max)(1_000_000_000, { message: 'minOrderValue cannot exceed Rp 1.000.000.000' }),
    __metadata("design:type", Number)
], CreateVoucherDto.prototype, "minOrderValue", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ enum: client_1.VoucherApplicability, description: 'Applicable to' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(client_1.VoucherApplicability),
    __metadata("design:type", String)
], CreateVoucherDto.prototype, "applicableTo", void 0);
