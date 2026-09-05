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
exports.UpdateTemplateDto = exports.CreateTemplateDto = void 0;
const class_validator_1 = require("class-validator");
const app_constants_1 = require("../../../common/constants/app.constants");
class CreateTemplateDto {
}
exports.CreateTemplateDto = CreateTemplateDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(1),
    (0, class_validator_1.MaxLength)(50),
    __metadata("design:type", String)
], CreateTemplateDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(1),
    (0, class_validator_1.MaxLength)(200),
    __metadata("design:type", String)
], CreateTemplateDto.prototype, "title", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(2000),
    __metadata("design:type", String)
], CreateTemplateDto.prototype, "description", void 0);
__decorate([
    (0, class_validator_1.IsEnum)(['PHYSICAL_GOODS', 'DIGITAL_GOODS', 'SERVICE', 'OTHER']),
    __metadata("design:type", String)
], CreateTemplateDto.prototype, "orderType", void 0);
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(app_constants_1.ORDER_MIN_VALUE),
    (0, class_validator_1.Max)(app_constants_1.ORDER_MAX_VALUE),
    __metadata("design:type", Number)
], CreateTemplateDto.prototype, "orderValue", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(['BUYER', 'SELLER', 'SPLIT']),
    __metadata("design:type", String)
], CreateTemplateDto.prototype, "feeResponsibility", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(app_constants_1.DELIVERY_DEADLINE_DAYS_MIN),
    (0, class_validator_1.Max)(app_constants_1.DELIVERY_DEADLINE_DAYS_MAX),
    __metadata("design:type", Number)
], CreateTemplateDto.prototype, "deliveryDeadlineDays", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], CreateTemplateDto.prototype, "isDefault", void 0);
class UpdateTemplateDto {
}
exports.UpdateTemplateDto = UpdateTemplateDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(1),
    (0, class_validator_1.MaxLength)(50),
    __metadata("design:type", String)
], UpdateTemplateDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(1),
    (0, class_validator_1.MaxLength)(200),
    __metadata("design:type", String)
], UpdateTemplateDto.prototype, "title", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(2000),
    __metadata("design:type", String)
], UpdateTemplateDto.prototype, "description", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(['PHYSICAL_GOODS', 'DIGITAL_GOODS', 'SERVICE', 'OTHER']),
    __metadata("design:type", String)
], UpdateTemplateDto.prototype, "orderType", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(app_constants_1.ORDER_MIN_VALUE),
    (0, class_validator_1.Max)(app_constants_1.ORDER_MAX_VALUE),
    __metadata("design:type", Number)
], UpdateTemplateDto.prototype, "orderValue", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(['BUYER', 'SELLER', 'SPLIT']),
    __metadata("design:type", String)
], UpdateTemplateDto.prototype, "feeResponsibility", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(app_constants_1.DELIVERY_DEADLINE_DAYS_MIN),
    (0, class_validator_1.Max)(app_constants_1.DELIVERY_DEADLINE_DAYS_MAX),
    __metadata("design:type", Number)
], UpdateTemplateDto.prototype, "deliveryDeadlineDays", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], UpdateTemplateDto.prototype, "isDefault", void 0);
