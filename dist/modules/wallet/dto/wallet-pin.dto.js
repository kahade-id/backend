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
exports.VerifyPinDto = exports.SetPinDto = void 0;
const class_validator_1 = require("class-validator");
const swagger_1 = require("@nestjs/swagger");
class SetPinDto {
}
exports.SetPinDto = SetPinDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'New wallet PIN (6 digits)', minLength: 6, maxLength: 6 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.Length)(6, 6, { message: 'PIN must be exactly 6 digits' }),
    (0, class_validator_1.Matches)(/^\d{6}$/, { message: 'PIN must contain only digits' }),
    __metadata("design:type", String)
], SetPinDto.prototype, "pin", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Current wallet PIN — required when changing an existing PIN', minLength: 6, maxLength: 6 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.Length)(6, 6, { message: 'Current PIN must be exactly 6 digits' }),
    (0, class_validator_1.Matches)(/^\d{6}$/, { message: 'Current PIN must contain only digits' }),
    __metadata("design:type", String)
], SetPinDto.prototype, "currentPin", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Account password — required when changing an existing PIN' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(1, { message: 'Password is required when changing an existing PIN' }),
    __metadata("design:type", String)
], SetPinDto.prototype, "password", void 0);
class VerifyPinDto {
}
exports.VerifyPinDto = VerifyPinDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Wallet PIN to verify (6 digits)', minLength: 6, maxLength: 6 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.Length)(6, 6, { message: 'PIN must be exactly 6 digits' }),
    (0, class_validator_1.Matches)(/^\d{6}$/, { message: 'PIN must contain only digits' }),
    __metadata("design:type", String)
], VerifyPinDto.prototype, "pin", void 0);
