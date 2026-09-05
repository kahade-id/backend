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
exports.CreateOrderDto = void 0;
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
class CreateOrderDto {
}
exports.CreateOrderDto = CreateOrderDto;
__decorate([
    (0, swagger_1.ApiProperty)({ enum: ['BUYER', 'SELLER'], description: 'Your role in the order' }),
    (0, class_validator_1.IsEnum)(['BUYER', 'SELLER'], { message: 'role must be BUYER or SELLER' }),
    __metadata("design:type", String)
], CreateOrderDto.prototype, "role", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Username of the counterpart', minLength: 3, maxLength: 50 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(3),
    (0, class_validator_1.MaxLength)(50),
    __metadata("design:type", String)
], CreateOrderDto.prototype, "counterpartUsername", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Order title', minLength: 3, maxLength: 100 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(3),
    (0, class_validator_1.MaxLength)(100),
    (0, class_transformer_1.Transform)(({ value }) => sanitizeText(value)),
    __metadata("design:type", String)
], CreateOrderDto.prototype, "title", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Order description', minLength: 10, maxLength: 500 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(10),
    (0, class_validator_1.MaxLength)(500),
    (0, class_transformer_1.Transform)(({ value }) => sanitizeText(value)),
    __metadata("design:type", String)
], CreateOrderDto.prototype, "description", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ enum: client_1.OrderType, description: 'Type of order' }),
    (0, class_validator_1.IsEnum)(client_1.OrderType, { message: 'orderType must be a valid OrderType enum value' }),
    __metadata("design:type", String)
], CreateOrderDto.prototype, "orderType", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Order value in IDR', minimum: app_constants_1.ORDER_MIN_VALUE, maximum: app_constants_1.ORDER_MAX_VALUE }),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(app_constants_1.ORDER_MIN_VALUE, { message: `Minimum order value is Rp ${app_constants_1.ORDER_MIN_VALUE.toLocaleString()}` }),
    (0, class_validator_1.Max)(app_constants_1.ORDER_MAX_VALUE, { message: `Maximum order value is Rp ${app_constants_1.ORDER_MAX_VALUE.toLocaleString()}` }),
    __metadata("design:type", Number)
], CreateOrderDto.prototype, "orderValue", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Delivery deadline in days', minimum: app_constants_1.DELIVERY_DEADLINE_DAYS_MIN, maximum: app_constants_1.DELIVERY_DEADLINE_DAYS_MAX }),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(app_constants_1.DELIVERY_DEADLINE_DAYS_MIN),
    (0, class_validator_1.Max)(app_constants_1.DELIVERY_DEADLINE_DAYS_MAX),
    __metadata("design:type", Number)
], CreateOrderDto.prototype, "deliveryDeadlineDays", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ enum: client_1.FeeResponsibility, description: 'Who pays the fee' }),
    (0, class_validator_1.IsEnum)(client_1.FeeResponsibility, { message: 'feeResponsibility must be BUYER, SELLER, or SPLIT' }),
    __metadata("design:type", String)
], CreateOrderDto.prototype, "feeResponsibility", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Voucher code to apply', maxLength: 50 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(50),
    __metadata("design:type", String)
], CreateOrderDto.prototype, "voucherCode", void 0);
