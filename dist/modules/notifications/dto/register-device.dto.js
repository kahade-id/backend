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
exports.RegisterDeviceDto = void 0;
const class_validator_1 = require("class-validator");
const swagger_1 = require("@nestjs/swagger");
class RegisterDeviceDto {
}
exports.RegisterDeviceDto = RegisterDeviceDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Push notification token', maxLength: 512 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(10),
    (0, class_validator_1.MaxLength)(512),
    (0, class_validator_1.Matches)(/^[a-zA-Z0-9:._/\-[\]]+$/, { message: 'Invalid push notification token format' }),
    __metadata("design:type", String)
], RegisterDeviceDto.prototype, "token", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ enum: ['android', 'ios', 'web'], description: 'Device platform' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsIn)(['android', 'ios', 'web']),
    __metadata("design:type", String)
], RegisterDeviceDto.prototype, "platform", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Stable per-install device fingerprint', maxLength: 128 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(8),
    (0, class_validator_1.MaxLength)(128),
    (0, class_validator_1.Matches)(/^[a-zA-Z0-9:._-]+$/, { message: 'Invalid device ID format' }),
    __metadata("design:type", String)
], RegisterDeviceDto.prototype, "deviceId", void 0);
