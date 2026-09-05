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
exports.ConfirmWithdrawOtpDto = void 0;
const class_validator_1 = require("class-validator");
const swagger_1 = require("@nestjs/swagger");
const is_valid_id_decorator_1 = require("../../../common/decorators/is-valid-id.decorator");
class ConfirmWithdrawOtpDto {
}
exports.ConfirmWithdrawOtpDto = ConfirmWithdrawOtpDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Transaction ID' }),
    (0, is_valid_id_decorator_1.IsValidId)(),
    __metadata("design:type", String)
], ConfirmWithdrawOtpDto.prototype, "txId", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'OTP code (6 digits)', minLength: 6, maxLength: 6 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.Length)(6, 6, { message: 'OTP must be exactly 6 digits' }),
    (0, class_validator_1.Matches)(/^\d{6}$/, { message: 'OTP must contain only numeric digits' }),
    __metadata("design:type", String)
], ConfirmWithdrawOtpDto.prototype, "otp", void 0);
