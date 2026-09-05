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
exports.ConfirmUploadDto = void 0;
const class_validator_1 = require("class-validator");
const swagger_1 = require("@nestjs/swagger");
class ConfirmUploadDto {
}
exports.ConfirmUploadDto = ConfirmUploadDto;
__decorate([
    (0, swagger_1.ApiProperty)({ example: 'uploads/kyc-ktp/usr123/1234567890-photo.jpg' }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.MaxLength)(512),
    __metadata("design:type", String)
], ConfirmUploadDto.prototype, "fileKey", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ example: 'a1b2c3...', description: 'SHA-256 hash of the uploaded file for integrity verification' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.Matches)(/^[a-f0-9]{64}$/, { message: 'sha256 must be a valid 64-character hex string' }),
    __metadata("design:type", String)
], ConfirmUploadDto.prototype, "sha256", void 0);
