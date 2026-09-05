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
exports.CreateCampaignDto = void 0;
const class_validator_1 = require("class-validator");
const class_transformer_1 = require("class-transformer");
const swagger_1 = require("@nestjs/swagger");
const client_1 = require("@prisma/client");
const trim = ({ value }) => typeof value === 'string' ? value.trim() : value;
class CreateCampaignDto {
}
exports.CreateCampaignDto = CreateCampaignDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Campaign name', minLength: 3, maxLength: 100 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(3),
    (0, class_validator_1.MaxLength)(100),
    (0, class_validator_1.Matches)(/\S/, { message: 'name cannot be blank' }),
    (0, class_transformer_1.Transform)(trim),
    __metadata("design:type", String)
], CreateCampaignDto.prototype, "name", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Campaign description', maxLength: 1000 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(1000),
    (0, class_transformer_1.Transform)(trim),
    __metadata("design:type", String)
], CreateCampaignDto.prototype, "description", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ enum: client_1.CampaignType, description: 'Campaign type' }),
    (0, class_validator_1.IsEnum)(client_1.CampaignType),
    __metadata("design:type", String)
], CreateCampaignDto.prototype, "type", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Campaign start date (ISO 8601)' }),
    (0, class_validator_1.IsDateString)(),
    __metadata("design:type", String)
], CreateCampaignDto.prototype, "startsAt", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Campaign end date (ISO 8601)' }),
    (0, class_validator_1.IsDateString)(),
    __metadata("design:type", String)
], CreateCampaignDto.prototype, "endsAt", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Flat discount value (IDR)', minimum: 1, maximum: 50_000_000 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(50_000_000, { message: 'discountValue cannot exceed Rp 50.000.000' }),
    __metadata("design:type", Number)
], CreateCampaignDto.prototype, "discountValue", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Discount percentage (0.01-100)' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0.01),
    (0, class_validator_1.Max)(100),
    __metadata("design:type", Number)
], CreateCampaignDto.prototype, "discountPercent", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Max discount cap (IDR)', minimum: 1, maximum: 50_000_000 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(50_000_000, { message: 'maxDiscount cannot exceed Rp 50.000.000' }),
    __metadata("design:type", Number)
], CreateCampaignDto.prototype, "maxDiscount", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Number of free transactions', minimum: 1, maximum: 1_000_000 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(1_000_000),
    __metadata("design:type", Number)
], CreateCampaignDto.prototype, "freeTransactions", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Target audience filter' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(500),
    (0, class_transformer_1.Transform)(trim),
    __metadata("design:type", String)
], CreateCampaignDto.prototype, "targetAudience", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Max total redemptions', minimum: 1, maximum: 10_000_000 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(10_000_000),
    __metadata("design:type", Number)
], CreateCampaignDto.prototype, "maxRedemptions", void 0);
