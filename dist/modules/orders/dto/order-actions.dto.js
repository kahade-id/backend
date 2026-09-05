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
exports.PayOrderDto = exports.ValidateCounterpartDto = exports.SubmitDisputeDto = exports.CancelOrderDto = exports.RespondExtensionDto = exports.RequestExtensionDto = exports.UpdateShippingDto = exports.ConfirmOrderDto = exports.CalculateFeeDto = void 0;
const class_validator_1 = require("class-validator");
const class_transformer_1 = require("class-transformer");
const client_1 = require("@prisma/client");
const swagger_1 = require("@nestjs/swagger");
const app_constants_1 = require("../../../common/constants/app.constants");
function sanitizeText(value) {
    if (typeof value !== 'string')
        return value;
    return value.replace(/[<>]/g, '').trim();
}
class CalculateFeeDto {
}
exports.CalculateFeeDto = CalculateFeeDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Order value in IDR', minimum: app_constants_1.ORDER_MIN_VALUE, maximum: app_constants_1.ORDER_MAX_VALUE }),
    (0, class_validator_1.IsNumber)({ maxDecimalPlaces: 0 }),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(app_constants_1.ORDER_MIN_VALUE),
    (0, class_validator_1.Max)(app_constants_1.ORDER_MAX_VALUE),
    __metadata("design:type", Number)
], CalculateFeeDto.prototype, "orderValue", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ enum: client_1.FeeResponsibility, description: 'Who pays the fee' }),
    (0, class_validator_1.IsEnum)(client_1.FeeResponsibility),
    __metadata("design:type", String)
], CalculateFeeDto.prototype, "feeResponsibility", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Voucher code to apply', maxLength: 50 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(50),
    __metadata("design:type", String)
], CalculateFeeDto.prototype, "voucherCode", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'User role for role-based voucher validation', enum: ['BUYER', 'SELLER'] }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsIn)(['BUYER', 'SELLER']),
    __metadata("design:type", String)
], CalculateFeeDto.prototype, "role", void 0);
class ConfirmOrderDto {
}
exports.ConfirmOrderDto = ConfirmOrderDto;
__decorate([
    (0, swagger_1.ApiProperty)({ enum: ['ACCEPT', 'REJECT'], description: 'Accept or reject the order' }),
    (0, class_validator_1.IsEnum)(['ACCEPT', 'REJECT']),
    __metadata("design:type", String)
], ConfirmOrderDto.prototype, "action", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Reason for rejection', maxLength: 500 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(500),
    __metadata("design:type", String)
], ConfirmOrderDto.prototype, "reason", void 0);
class UpdateShippingDto {
}
exports.UpdateShippingDto = UpdateShippingDto;
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Tracking number; required for PHYSICAL_GOODS only', minLength: 3, maxLength: 100 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(3),
    (0, class_validator_1.MaxLength)(100),
    __metadata("design:type", String)
], UpdateShippingDto.prototype, "trackingNumber", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Courier name; required for PHYSICAL_GOODS only', minLength: 2, maxLength: 100 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(2),
    (0, class_validator_1.MaxLength)(100),
    __metadata("design:type", String)
], UpdateShippingDto.prototype, "courierName", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Tracking notes', maxLength: 500 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(500),
    __metadata("design:type", String)
], UpdateShippingDto.prototype, "trackingNotes", void 0);
class RequestExtensionDto {
}
exports.RequestExtensionDto = RequestExtensionDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Number of extension days', minimum: 1, maximum: 14 }),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(14),
    __metadata("design:type", Number)
], RequestExtensionDto.prototype, "extensionDays", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Reason for extension', minLength: 10, maxLength: 500 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(10),
    (0, class_validator_1.MaxLength)(500),
    __metadata("design:type", String)
], RequestExtensionDto.prototype, "reason", void 0);
class RespondExtensionDto {
}
exports.RespondExtensionDto = RespondExtensionDto;
__decorate([
    (0, swagger_1.ApiProperty)({ enum: ['APPROVE', 'REJECT'], description: 'Approve or reject extension' }),
    (0, class_validator_1.IsEnum)(['APPROVE', 'REJECT']),
    __metadata("design:type", String)
], RespondExtensionDto.prototype, "action", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Response note', maxLength: 500 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(500),
    __metadata("design:type", String)
], RespondExtensionDto.prototype, "note", void 0);
class CancelOrderDto {
}
exports.CancelOrderDto = CancelOrderDto;
__decorate([
    (0, swagger_1.ApiProperty)({
        description: 'Cancellation reason',
        enum: ['CHANGED_MIND', 'WRONG_DETAILS', 'DUPLICATE_ORDER', 'MUTUAL_AGREEMENT', 'COUNTERPART_UNRESPONSIVE', 'OTHER'],
    }),
    (0, class_validator_1.IsIn)(['CHANGED_MIND', 'WRONG_DETAILS', 'DUPLICATE_ORDER', 'MUTUAL_AGREEMENT', 'COUNTERPART_UNRESPONSIVE', 'OTHER'], {
        message: 'reason must be one of: CHANGED_MIND, WRONG_DETAILS, DUPLICATE_ORDER, MUTUAL_AGREEMENT, COUNTERPART_UNRESPONSIVE, OTHER',
    }),
    __metadata("design:type", String)
], CancelOrderDto.prototype, "reason", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Additional cancellation note', maxLength: 500 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(500),
    (0, class_transformer_1.Transform)(({ value }) => sanitizeText(value)),
    __metadata("design:type", String)
], CancelOrderDto.prototype, "note", void 0);
class SubmitDisputeDto {
}
exports.SubmitDisputeDto = SubmitDisputeDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Dispute claim', minLength: 20, maxLength: 2000 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(20),
    (0, class_validator_1.MaxLength)(2000),
    __metadata("design:type", String)
], SubmitDisputeDto.prototype, "claim", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Evidence file URLs', type: [String], minItems: 0, maxItems: 10, required: false }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ArrayMaxSize)(10),
    (0, class_validator_1.IsString)({ each: true }),
    __metadata("design:type", Array)
], SubmitDisputeDto.prototype, "fileUrls", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Evidence file MIME types', type: [String], maxItems: 10, required: false }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ArrayMaxSize)(10),
    (0, class_validator_1.IsIn)(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], { each: true, message: 'Invalid file type. Allowed: image/jpeg, image/png, image/webp, application/pdf' }),
    __metadata("design:type", Array)
], SubmitDisputeDto.prototype, "fileTypes", void 0);
class ValidateCounterpartDto {
}
exports.ValidateCounterpartDto = ValidateCounterpartDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Username to validate', minLength: 3, maxLength: 50 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(3),
    (0, class_validator_1.MaxLength)(50),
    __metadata("design:type", String)
], ValidateCounterpartDto.prototype, "username", void 0);
class PayOrderDto {
}
exports.PayOrderDto = PayOrderDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: '6-digit wallet PIN for payment authorization', required: true }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(6),
    (0, class_validator_1.MaxLength)(6),
    __metadata("design:type", String)
], PayOrderDto.prototype, "pin", void 0);
