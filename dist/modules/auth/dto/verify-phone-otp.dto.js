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
exports.VerifyPhoneOtpDto = void 0;
const class_validator_1 = require("class-validator");
const swagger_1 = require("@nestjs/swagger");
const class_transformer_1 = require("class-transformer");
const device_id_validation_1 = require("./device-id.validation");
class VerifyPhoneOtpDto {
}
exports.VerifyPhoneOtpDto = VerifyPhoneOtpDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Indonesian phone number', maxLength: 20 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.MaxLength)(20),
    (0, class_validator_1.Matches)(/^(\+62|62|0)8[1-9][0-9]{7,10}$/, { message: 'Invalid Indonesian phone number format' }),
    (0, class_transformer_1.Transform)(({ value }) => (typeof value === 'string' ? value.replace(/[\s\-.]/g, '') : value)),
    __metadata("design:type", String)
], VerifyPhoneOtpDto.prototype, "phoneNumber", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: '6-digit OTP code' }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.Length)(6, 6, { message: 'OTP must be exactly 6 digits' }),
    (0, class_validator_1.Matches)(/^[0-9]{6}$/, { message: 'OTP must contain only digits' }),
    __metadata("design:type", String)
], VerifyPhoneOtpDto.prototype, "code", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Device identifier', maxLength: 255 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.MaxLength)(255),
    (0, class_validator_1.Matches)(device_id_validation_1.DEVICE_ID_PATTERN, { message: device_id_validation_1.DEVICE_ID_MESSAGE }),
    (0, class_transformer_1.Transform)(({ value }) => (0, device_id_validation_1.normalizeDeviceId)(value)),
    __metadata("design:type", String)
], VerifyPhoneOtpDto.prototype, "deviceId", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Device information', maxLength: 512 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(512),
    __metadata("design:type", String)
], VerifyPhoneOtpDto.prototype, "deviceInfo", void 0);
