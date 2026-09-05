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
exports.PhoneRegisterDto = void 0;
const class_validator_1 = require("class-validator");
const swagger_1 = require("@nestjs/swagger");
const class_transformer_1 = require("class-transformer");
const register_dto_1 = require("./register.dto");
const device_id_validation_1 = require("./device-id.validation");
const USERNAME_REGEX = /^[a-zA-Z0-9._]+$/;
const USERNAME_MSG = 'Username must be 3-30 characters and contain only letters, numbers, dots, and underscores';
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()\-_=+{};:,<.>/?\\|'"`~[\]@])/;
const PASSWORD_MSG = 'Password must contain at least 1 uppercase, 1 lowercase, 1 digit, and 1 special character';
class PhoneRegisterDto {
}
exports.PhoneRegisterDto = PhoneRegisterDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Temp token from OTP verification' }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], PhoneRegisterDto.prototype, "tempToken", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Full name', minLength: 2, maxLength: 60 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.MinLength)(2),
    (0, class_validator_1.MaxLength)(60),
    (0, class_validator_1.Matches)(/^[^<>]*$/, { message: 'Name must not contain < or > characters' }),
    (0, class_transformer_1.Transform)(({ value }) => (typeof value === 'string' ? value.trim() : value)),
    __metadata("design:type", String)
], PhoneRegisterDto.prototype, "fullName", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Unique username (3-30 characters)', minLength: 3, maxLength: 30 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.MinLength)(3),
    (0, class_validator_1.MaxLength)(30),
    (0, class_validator_1.Matches)(USERNAME_REGEX, { message: USERNAME_MSG }),
    (0, class_transformer_1.Transform)(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value)),
    __metadata("design:type", String)
], PhoneRegisterDto.prototype, "username", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Date of birth (ISO 8601: YYYY-MM-DD)', example: '1995-06-15' }),
    (0, class_validator_1.IsDateString)({}, { message: 'Invalid date of birth format (use YYYY-MM-DD)' }),
    (0, class_transformer_1.Transform)(({ value }) => {
        if (typeof value !== 'string')
            return value;
        const dob = new Date(value);
        if (isNaN(dob.getTime()))
            return value;
        const today = new Date();
        let age = today.getFullYear() - dob.getFullYear();
        const m = today.getMonth() - dob.getMonth();
        if (m < 0 || (m === 0 && today.getDate() < dob.getDate()))
            age--;
        if (age < 13)
            return '__UNDERAGE__';
        if (age > 120)
            return '__INVALID_AGE__';
        return value;
    }),
    (0, class_validator_1.Matches)(/^\d{4}-\d{2}-\d{2}$/, { message: 'Date of birth must be YYYY-MM-DD format and age must be at least 13' }),
    __metadata("design:type", String)
], PhoneRegisterDto.prototype, "dateOfBirth", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Gender', enum: register_dto_1.GenderDto }),
    (0, class_validator_1.IsEnum)(register_dto_1.GenderDto, { message: 'Invalid gender value' }),
    __metadata("design:type", String)
], PhoneRegisterDto.prototype, "gender", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Email address', maxLength: 254 }),
    (0, class_validator_1.IsEmail)(),
    (0, class_validator_1.MaxLength)(254),
    (0, class_transformer_1.Transform)(({ value }) => (typeof value === 'string' ? value.toLowerCase().trim() : value)),
    __metadata("design:type", String)
], PhoneRegisterDto.prototype, "email", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Password (min 12 chars, must contain uppercase, lowercase, digit, and special character)', minLength: 12, maxLength: 72 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(12),
    (0, class_validator_1.MaxLength)(72),
    (0, class_validator_1.Matches)(PASSWORD_REGEX, { message: PASSWORD_MSG }),
    __metadata("design:type", String)
], PhoneRegisterDto.prototype, "password", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Wallet PIN (6 digits)', minLength: 6, maxLength: 6 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.Length)(6, 6, { message: 'PIN must be exactly 6 digits' }),
    (0, class_validator_1.Matches)(/^\d{6}$/, { message: 'PIN must contain only digits' }),
    __metadata("design:type", String)
], PhoneRegisterDto.prototype, "pin", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Full address', maxLength: 500 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(500),
    (0, class_validator_1.Matches)(/^[^<>]*$/, { message: 'Address must not contain < or > characters' }),
    (0, class_transformer_1.Transform)(({ value }) => (typeof value === 'string' ? value.trim() : value)),
    __metadata("design:type", String)
], PhoneRegisterDto.prototype, "address", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Referral code (optional)', maxLength: 20 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(20),
    (0, class_transformer_1.Transform)(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value)),
    __metadata("design:type", String)
], PhoneRegisterDto.prototype, "referralCode", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Device identifier bound to the phone-verification token', maxLength: 255 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.MaxLength)(255),
    (0, class_validator_1.Matches)(device_id_validation_1.DEVICE_ID_PATTERN, { message: device_id_validation_1.DEVICE_ID_MESSAGE }),
    (0, class_transformer_1.Transform)(({ value }) => (0, device_id_validation_1.normalizeDeviceId)(value)),
    __metadata("design:type", String)
], PhoneRegisterDto.prototype, "deviceId", void 0);
