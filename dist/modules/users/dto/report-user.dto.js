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
exports.ReportUserDto = void 0;
const class_validator_1 = require("class-validator");
const swagger_1 = require("@nestjs/swagger");
const client_1 = require("@prisma/client");
const STORAGE_URL_PATTERN = /^https:\/\/cdn\.kahade\.id\//;
class ReportUserDto {
}
exports.ReportUserDto = ReportUserDto;
__decorate([
    (0, swagger_1.ApiProperty)({ enum: client_1.ReportCategory, description: 'Report category' }),
    (0, class_validator_1.IsEnum)(client_1.ReportCategory, { message: 'Invalid report category' }),
    __metadata("design:type", String)
], ReportUserDto.prototype, "category", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Report description', minLength: 20, maxLength: 500 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)({ message: 'Report description is required' }),
    (0, class_validator_1.MinLength)(20, { message: 'Report reason must be at least 20 characters to provide sufficient context' }),
    (0, class_validator_1.MaxLength)(500, { message: 'Description must be at most 500 characters' }),
    __metadata("design:type", String)
], ReportUserDto.prototype, "description", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Evidence URLs (must be platform storage URLs)' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ArrayMaxSize)(10, { message: 'Maximum 10 evidence URLs' }),
    (0, class_validator_1.Matches)(STORAGE_URL_PATTERN, { each: true, message: 'Evidence URLs must be platform storage URLs (https://cdn.kahade.id/)' }),
    (0, class_validator_1.MaxLength)(500, { each: true, message: 'URL is too long' }),
    __metadata("design:type", Array)
], ReportUserDto.prototype, "evidenceUrls", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Related order ID' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], ReportUserDto.prototype, "relatedOrderId", void 0);
