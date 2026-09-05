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
exports.WalletAdjustDto = exports.WalletAdjustType = void 0;
const class_validator_1 = require("class-validator");
const swagger_1 = require("@nestjs/swagger");
const app_constants_1 = require("../../../../common/constants/app.constants");
var WalletAdjustType;
(function (WalletAdjustType) {
    WalletAdjustType["CREDIT"] = "CREDIT";
    WalletAdjustType["DEBIT"] = "DEBIT";
})(WalletAdjustType || (exports.WalletAdjustType = WalletAdjustType = {}));
class WalletAdjustDto {
}
exports.WalletAdjustDto = WalletAdjustDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Amount in IDR (whole number; will be converted to sen internally)', minimum: 1, maximum: app_constants_1.WALLET_DAILY_TOPUP_LIMIT }),
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.IsInt)({ message: 'amount must be a whole number (no decimals)' }),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(app_constants_1.WALLET_DAILY_TOPUP_LIMIT, { message: `Maximum single adjustment is Rp ${app_constants_1.WALLET_DAILY_TOPUP_LIMIT.toLocaleString()}` }),
    __metadata("design:type", Number)
], WalletAdjustDto.prototype, "amount", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ enum: WalletAdjustType, description: 'CREDIT to add funds, DEBIT to subtract funds' }),
    (0, class_validator_1.IsEnum)(WalletAdjustType),
    __metadata("design:type", String)
], WalletAdjustDto.prototype, "type", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Reason for the wallet adjustment', minLength: 5, maxLength: 1000 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(5),
    (0, class_validator_1.MaxLength)(1000),
    __metadata("design:type", String)
], WalletAdjustDto.prototype, "reason", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Idempotency key to prevent duplicate adjustments (SEC-013)' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(8),
    (0, class_validator_1.MaxLength)(128),
    __metadata("design:type", String)
], WalletAdjustDto.prototype, "idempotencyKey", void 0);
