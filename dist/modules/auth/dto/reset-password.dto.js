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
exports.ResetPasswordDto = void 0;
const class_validator_1 = require("class-validator");
const swagger_1 = require("@nestjs/swagger");
const class_transformer_1 = require("class-transformer");
const match_decorator_1 = require("../../../common/decorators/match.decorator");
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()\-_=+{};:,<.>/?\\|'"`~[\]@])/;
const PASSWORD_MSG = 'Password must contain at least 1 uppercase, 1 lowercase, 1 digit, and 1 special character';
class ResetPasswordDto {
}
exports.ResetPasswordDto = ResetPasswordDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Email address', maxLength: 254 }),
    (0, class_validator_1.IsEmail)(),
    (0, class_validator_1.MaxLength)(254),
    (0, class_transformer_1.Transform)(({ value }) => (typeof value === 'string' ? value.toLowerCase().trim() : value)),
    __metadata("design:type", String)
], ResetPasswordDto.prototype, "email", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'OTP code (6 digits)', minLength: 6, maxLength: 6 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.Length)(6, 6),
    (0, class_validator_1.Matches)(/^\d{6}$/, { message: 'otp must contain exactly 6 digits' }),
    __metadata("design:type", String)
], ResetPasswordDto.prototype, "otp", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'New password', minLength: 12, maxLength: 72 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(12),
    (0, class_validator_1.MaxLength)(72),
    (0, class_validator_1.Matches)(PASSWORD_REGEX, { message: PASSWORD_MSG }),
    __metadata("design:type", String)
], ResetPasswordDto.prototype, "newPassword", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Confirm new password', minLength: 12, maxLength: 72 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(12),
    (0, class_validator_1.MaxLength)(72),
    (0, match_decorator_1.Match)('newPassword', { message: 'confirmPassword must match newPassword' }),
    __metadata("design:type", String)
], ResetPasswordDto.prototype, "confirmPassword", void 0);
