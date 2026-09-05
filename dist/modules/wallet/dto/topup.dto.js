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
exports.TopupDto = void 0;
const class_validator_1 = require("class-validator");
const class_transformer_1 = require("class-transformer");
const client_1 = require("@prisma/client");
const swagger_1 = require("@nestjs/swagger");
const app_constants_1 = require("../../../common/constants/app.constants");
const TOPUP_PAYMENT_METHODS = Object.values(client_1.PaymentMethod).filter((m) => m !== client_1.PaymentMethod.KAHADE_WALLET);
class TopupDto {
}
exports.TopupDto = TopupDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Top-up amount in IDR', minimum: 10000, maximum: app_constants_1.WALLET_DAILY_TOPUP_LIMIT }),
    (0, class_transformer_1.Transform)(({ value }) => {
        if (typeof value === 'number')
            return value;
        if (typeof value === 'string') {
            if (!/^\d+$/.test(value.trim()))
                return NaN;
            return Number(value.trim());
        }
        return value;
    }),
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.IsInt)({ message: 'amount must be a whole number (no decimals)' }),
    (0, class_validator_1.Min)(10000, { message: 'Minimum top-up is Rp 10,000' }),
    (0, class_validator_1.Max)(app_constants_1.WALLET_DAILY_TOPUP_LIMIT, { message: `Maximum single top-up is Rp ${app_constants_1.WALLET_DAILY_TOPUP_LIMIT.toLocaleString('id-ID')}` }),
    __metadata("design:type", Number)
], TopupDto.prototype, "amount", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({
        enum: TOPUP_PAYMENT_METHODS,
        description: 'Payment method (KAHADE_WALLET not available for top-up)',
    }),
    (0, class_validator_1.IsEnum)(TOPUP_PAYMENT_METHODS, { message: 'Invalid payment method' }),
    __metadata("design:type", Object)
], TopupDto.prototype, "method", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Card token from Midtrans.js tokenization (required for CREDIT_CARD method)' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], TopupDto.prototype, "cardToken", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Wallet PIN (6 digits) — collected by mobile but not verified for top-up' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.Length)(6, 6, { message: 'Wallet PIN must be exactly 6 digits' }),
    (0, class_validator_1.Matches)(/^\d{6}$/, { message: 'Wallet PIN must consist of 6 numeric digits' }),
    __metadata("design:type", String)
], TopupDto.prototype, "pin", void 0);
