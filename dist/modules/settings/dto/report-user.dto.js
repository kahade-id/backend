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
exports.ReportUserSettingsDto = exports.ReportCategoryDto = void 0;
const class_validator_1 = require("class-validator");
const is_valid_id_decorator_1 = require("../../../common/decorators/is-valid-id.decorator");
const swagger_1 = require("@nestjs/swagger");
var ReportCategoryDto;
(function (ReportCategoryDto) {
    ReportCategoryDto["FRAUD"] = "FRAUD";
    ReportCategoryDto["FAKE_IDENTITY"] = "FAKE_IDENTITY";
    ReportCategoryDto["INAPPROPRIATE_CONTENT"] = "INAPPROPRIATE_CONTENT";
    ReportCategoryDto["TNC_VIOLATION"] = "TNC_VIOLATION";
    ReportCategoryDto["MONEY_LAUNDERING"] = "MONEY_LAUNDERING";
    ReportCategoryDto["SPAM"] = "SPAM";
    ReportCategoryDto["OTHER"] = "OTHER";
})(ReportCategoryDto || (exports.ReportCategoryDto = ReportCategoryDto = {}));
class ReportUserSettingsDto {
}
exports.ReportUserSettingsDto = ReportUserSettingsDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'ID of the user being reported' }),
    (0, is_valid_id_decorator_1.IsValidId)(),
    __metadata("design:type", String)
], ReportUserSettingsDto.prototype, "targetId", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ enum: ReportCategoryDto, description: 'Report category' }),
    (0, class_validator_1.IsEnum)(ReportCategoryDto),
    __metadata("design:type", String)
], ReportUserSettingsDto.prototype, "category", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Report description', maxLength: 500 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(500),
    __metadata("design:type", String)
], ReportUserSettingsDto.prototype, "description", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Evidence URLs', type: [String], maxItems: 10 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.IsUrl)({ protocols: ['http', 'https'] }, { each: true, message: 'Each evidence URL must be a valid HTTP(S) URL' }),
    (0, class_validator_1.MaxLength)(500, { each: true }),
    (0, class_validator_1.ArrayMaxSize)(10),
    __metadata("design:type", Array)
], ReportUserSettingsDto.prototype, "evidenceUrls", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Related order ID' }),
    (0, class_validator_1.IsOptional)(),
    (0, is_valid_id_decorator_1.IsValidId)({ message: 'relatedOrderId must be a valid ID' }),
    __metadata("design:type", String)
], ReportUserSettingsDto.prototype, "relatedOrderId", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Related message ID' }),
    (0, class_validator_1.IsOptional)(),
    (0, is_valid_id_decorator_1.IsValidId)(),
    __metadata("design:type", String)
], ReportUserSettingsDto.prototype, "relatedMessageId", void 0);
