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
exports.CreateOrderLinkDto = void 0;
const class_validator_1 = require("class-validator");
const client_1 = require("@prisma/client");
const swagger_1 = require("@nestjs/swagger");
const app_constants_1 = require("../../../common/constants/app.constants");
class CreateOrderLinkDto {
}
exports.CreateOrderLinkDto = CreateOrderLinkDto;
__decorate([
    (0, swagger_1.ApiProperty)({ enum: ['BUYER', 'SELLER'] }),
    (0, class_validator_1.IsEnum)(['BUYER', 'SELLER'], { message: 'role must be BUYER or SELLER' }),
    __metadata("design:type", String)
], CreateOrderLinkDto.prototype, "role", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ minLength: 3, maxLength: 100 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(3),
    (0, class_validator_1.MaxLength)(100),
    __metadata("design:type", String)
], CreateOrderLinkDto.prototype, "title", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ minLength: 10, maxLength: 500 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(10),
    (0, class_validator_1.MaxLength)(500),
    __metadata("design:type", String)
], CreateOrderLinkDto.prototype, "description", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ enum: client_1.OrderType }),
    (0, class_validator_1.IsEnum)(client_1.OrderType),
    __metadata("design:type", String)
], CreateOrderLinkDto.prototype, "orderType", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ minimum: app_constants_1.ORDER_MIN_VALUE, maximum: app_constants_1.ORDER_MAX_VALUE }),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(app_constants_1.ORDER_MIN_VALUE),
    (0, class_validator_1.Max)(app_constants_1.ORDER_MAX_VALUE),
    __metadata("design:type", Number)
], CreateOrderLinkDto.prototype, "orderValue", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ minimum: app_constants_1.DELIVERY_DEADLINE_DAYS_MIN, maximum: app_constants_1.DELIVERY_DEADLINE_DAYS_MAX }),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(app_constants_1.DELIVERY_DEADLINE_DAYS_MIN),
    (0, class_validator_1.Max)(app_constants_1.DELIVERY_DEADLINE_DAYS_MAX),
    __metadata("design:type", Number)
], CreateOrderLinkDto.prototype, "deliveryDeadlineDays", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ enum: client_1.FeeResponsibility }),
    (0, class_validator_1.IsEnum)(client_1.FeeResponsibility),
    __metadata("design:type", String)
], CreateOrderLinkDto.prototype, "feeResponsibility", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ maxLength: 50 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(50),
    __metadata("design:type", String)
], CreateOrderLinkDto.prototype, "counterpartUsername", void 0);
