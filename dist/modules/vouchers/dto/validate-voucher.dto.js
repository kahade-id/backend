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
exports.ValidateVoucherDto = void 0;
const class_validator_1 = require("class-validator");
const class_transformer_1 = require("class-transformer");
const swagger_1 = require("@nestjs/swagger");
const class_validator_2 = require("class-validator");
class ValidateVoucherDto {
}
exports.ValidateVoucherDto = ValidateVoucherDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Voucher code (A-Z, 0-9, underscore, or hyphen)', maxLength: 30 }),
    (0, class_transformer_1.Transform)(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value)),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.MaxLength)(30),
    (0, class_validator_2.Matches)(/^[A-Z0-9_-]+$/, { message: 'code may contain only A-Z, 0-9, underscore, or hyphen' }),
    __metadata("design:type", String)
], ValidateVoucherDto.prototype, "code", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({
        description: 'Order value in IDR (optional for preview validation)',
        minimum: 1,
    }),
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Number),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    __metadata("design:type", Number)
], ValidateVoucherDto.prototype, "orderValue", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({
        description: 'User role for role-based voucher validation',
        enum: ['BUYER', 'SELLER'],
    }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsIn)(['BUYER', 'SELLER']),
    __metadata("design:type", String)
], ValidateVoucherDto.prototype, "userRole", void 0);
