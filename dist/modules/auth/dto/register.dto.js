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
exports.RegisterDto = exports.GenderDto = void 0;
const class_validator_1 = require("class-validator");
const swagger_1 = require("@nestjs/swagger");
const class_transformer_1 = require("class-transformer");
var GenderDto;
(function (GenderDto) {
    GenderDto["MALE"] = "MALE";
    GenderDto["FEMALE"] = "FEMALE";
    GenderDto["OTHER"] = "OTHER";
    GenderDto["PREFER_NOT_TO_SAY"] = "PREFER_NOT_TO_SAY";
})(GenderDto || (exports.GenderDto = GenderDto = {}));
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()\-_=+{};:,<.>/?\\|'"`~[\]@])/;
const PASSWORD_MSG = 'Password must contain at least 1 uppercase, 1 lowercase, 1 digit, and 1 special character';
const USERNAME_REGEX = /^[a-zA-Z0-9._]+$/;
const USERNAME_MSG = 'Username must be 3-30 characters and contain only letters, numbers, dots, and underscores';
class RegisterDto {
}
exports.RegisterDto = RegisterDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Full name', minLength: 2, maxLength: 60 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.MinLength)(2),
    (0, class_validator_1.MaxLength)(60),
    (0, class_validator_1.Matches)(/^[^<>]*$/, { message: 'Name must not contain < or > characters' }),
    (0, class_transformer_1.Transform)(({ value }) => (typeof value === 'string' ? value.trim() : value)),
    __metadata("design:type", String)
], RegisterDto.prototype, "fullName", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Unique username (3-30 characters)', minLength: 3, maxLength: 30 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(3),
    (0, class_validator_1.MaxLength)(30),
    (0, class_validator_1.Matches)(USERNAME_REGEX, { message: USERNAME_MSG }),
    (0, class_transformer_1.Transform)(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value)),
    __metadata("design:type", String)
], RegisterDto.prototype, "username", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Email address', maxLength: 254 }),
    (0, class_validator_1.IsEmail)(),
    (0, class_validator_1.MaxLength)(254),
    (0, class_transformer_1.Transform)(({ value }) => (typeof value === 'string' ? value.toLowerCase().trim() : value)),
    __metadata("design:type", String)
], RegisterDto.prototype, "email", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Password (min 12 chars, must contain uppercase, lowercase, digit, and special character)', minLength: 12, maxLength: 72 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(12),
    (0, class_validator_1.MaxLength)(72),
    (0, class_validator_1.Matches)(PASSWORD_REGEX, { message: PASSWORD_MSG }),
    __metadata("design:type", String)
], RegisterDto.prototype, "password", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Confirm password', minLength: 12, maxLength: 72 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(12),
    (0, class_validator_1.MaxLength)(72),
    __metadata("design:type", String)
], RegisterDto.prototype, "confirmPassword", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Phone number (E.164 or local Indonesian format, e.g. 08xx)', maxLength: 20 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(20),
    (0, class_validator_1.Matches)(/^(\+62|62|0)8[1-9][0-9]{7,10}$/, { message: 'Invalid Indonesian phone number format' }),
    __metadata("design:type", String)
], RegisterDto.prototype, "phoneNumber", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Date of birth (ISO 8601: YYYY-MM-DD)', example: '1995-06-15' }),
    (0, class_validator_1.IsOptional)(),
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
], RegisterDto.prototype, "dateOfBirth", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Gender', enum: GenderDto }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(GenderDto, { message: 'Invalid gender value' }),
    __metadata("design:type", String)
], RegisterDto.prototype, "gender", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Referral code (optional)', maxLength: 20 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(20),
    (0, class_transformer_1.Transform)(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value)),
    __metadata("design:type", String)
], RegisterDto.prototype, "referralCode", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Captcha challenge ID' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsUUID)(),
    __metadata("design:type", String)
], RegisterDto.prototype, "captchaId", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Captcha answer (X position 0-100)' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    (0, class_validator_1.Max)(100),
    __metadata("design:type", Number)
], RegisterDto.prototype, "captchaAnswer", void 0);
