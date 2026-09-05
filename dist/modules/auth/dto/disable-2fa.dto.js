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
exports.Disable2faDto = void 0;
const class_validator_1 = require("class-validator");
const swagger_1 = require("@nestjs/swagger");
class Disable2faDto {
}
exports.Disable2faDto = Disable2faDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Current account password', maxLength: 72 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)({ message: 'Password is required' }),
    (0, class_validator_1.MaxLength)(72),
    __metadata("design:type", String)
], Disable2faDto.prototype, "password", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Six-digit authenticator TOTP code or a 10–16 character backup code', minLength: 6, maxLength: 16 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.Length)(6, 16),
    (0, class_validator_1.Matches)(/^(?:\d{6}|[A-Za-z0-9]{10,16})$/, { message: 'Enter a six-digit authenticator code or a 10–16 character backup code' }),
    __metadata("design:type", String)
], Disable2faDto.prototype, "code", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Email OTP code for verification', minLength: 6, maxLength: 6 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.Length)(6, 6),
    (0, class_validator_1.Matches)(/^\d{6}$/, { message: 'emailOtpCode must contain exactly 6 digits' }),
    __metadata("design:type", String)
], Disable2faDto.prototype, "emailOtpCode", void 0);
