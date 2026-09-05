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
exports.ChangePasswordDto = void 0;
const class_validator_1 = require("class-validator");
const swagger_1 = require("@nestjs/swagger");
const match_decorator_1 = require("../../../common/decorators/match.decorator");
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()\-_=+{};:,<.>/?\\|'"`~[\]@])/;
const PASSWORD_MSG = 'Password must contain at least 1 uppercase, 1 lowercase, 1 digit, and 1 special character';
class ChangePasswordDto {
}
exports.ChangePasswordDto = ChangePasswordDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Current password', maxLength: 72 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)({ message: 'Current password is required' }),
    (0, class_validator_1.MaxLength)(72),
    __metadata("design:type", String)
], ChangePasswordDto.prototype, "currentPassword", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'New password', minLength: 12, maxLength: 72 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(12),
    (0, class_validator_1.MaxLength)(72),
    (0, class_validator_1.Matches)(PASSWORD_REGEX, { message: PASSWORD_MSG }),
    __metadata("design:type", String)
], ChangePasswordDto.prototype, "newPassword", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Confirm new password', minLength: 12, maxLength: 72 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(12),
    (0, class_validator_1.MaxLength)(72),
    (0, match_decorator_1.Match)('newPassword', { message: 'confirmPassword must match newPassword' }),
    __metadata("design:type", String)
], ChangePasswordDto.prototype, "confirmPassword", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Authenticator or backup code when 2FA is enabled', required: false, maxLength: 16 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(16),
    (0, class_validator_1.Matches)(/^(?:\d{6}|[A-Za-z0-9]{10,16})$/, {
        message: 'mfaCode must be a six-digit authenticator code or a 10–16 character backup code',
    }),
    __metadata("design:type", String)
], ChangePasswordDto.prototype, "mfaCode", void 0);
