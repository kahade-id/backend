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
exports.AdminVerify2faDto = void 0;
const class_validator_1 = require("class-validator");
const swagger_1 = require("@nestjs/swagger");
class AdminVerify2faDto {
}
exports.AdminVerify2faDto = AdminVerify2faDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Temporary token issued by /admin/auth/login', maxLength: 512 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(512),
    __metadata("design:type", String)
], AdminVerify2faDto.prototype, "tempToken", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'TOTP code from authenticator app', minLength: 6, maxLength: 6 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.Matches)(/^\d{6}$/),
    __metadata("design:type", String)
], AdminVerify2faDto.prototype, "totpToken", void 0);
