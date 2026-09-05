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
exports.Verify2faLoginDto = void 0;
const class_validator_1 = require("class-validator");
const swagger_1 = require("@nestjs/swagger");
class Verify2faLoginDto {
}
exports.Verify2faLoginDto = Verify2faLoginDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Temporary token from login', maxLength: 512 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(512),
    __metadata("design:type", String)
], Verify2faLoginDto.prototype, "tempToken", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Six-digit TOTP code or 10–16 character backup code', minLength: 6, maxLength: 16 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.Length)(6, 16),
    (0, class_validator_1.Matches)(/^(?:\d{6}|[A-Za-z0-9]{10,16})$/, {
        message: 'code must be a six-digit authenticator code or a 10–16 character backup code',
    }),
    __metadata("design:type", String)
], Verify2faLoginDto.prototype, "code", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Device identifier', maxLength: 255 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.MaxLength)(255),
    __metadata("design:type", String)
], Verify2faLoginDto.prototype, "deviceId", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Device information', maxLength: 512 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(512),
    __metadata("design:type", String)
], Verify2faLoginDto.prototype, "deviceInfo", void 0);
