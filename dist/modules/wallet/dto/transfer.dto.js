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
exports.TransferDto = void 0;
const class_validator_1 = require("class-validator");
const class_transformer_1 = require("class-transformer");
const swagger_1 = require("@nestjs/swagger");
const app_constants_1 = require("../../../common/constants/app.constants");
class TransferDto {
}
exports.TransferDto = TransferDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Recipient user ID or username' }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)({ message: 'Recipient is required' }),
    __metadata("design:type", String)
], TransferDto.prototype, "recipientId", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Transfer amount in IDR', minimum: app_constants_1.WALLET_MIN_TRANSFER, maximum: app_constants_1.WALLET_MAX_TRANSFER_PER_TX }),
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
    (0, class_validator_1.Min)(app_constants_1.WALLET_MIN_TRANSFER, { message: `Minimum transfer is Rp ${app_constants_1.WALLET_MIN_TRANSFER.toLocaleString()}` }),
    (0, class_validator_1.Max)(app_constants_1.WALLET_MAX_TRANSFER_PER_TX, { message: `Maximum transfer is Rp ${app_constants_1.WALLET_MAX_TRANSFER_PER_TX.toLocaleString()}` }),
    __metadata("design:type", Number)
], TransferDto.prototype, "amount", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: '6-digit wallet PIN for transfer authorization' }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.Length)(6, 6, { message: 'Wallet PIN must be exactly 6 digits' }),
    (0, class_validator_1.Matches)(/^\d{6}$/, { message: 'Wallet PIN must consist of 6 numeric digits' }),
    __metadata("design:type", String)
], TransferDto.prototype, "pin", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Optional note for the transfer' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(200, { message: 'Note must be at most 200 characters' }),
    __metadata("design:type", String)
], TransferDto.prototype, "note", void 0);
