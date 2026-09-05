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
exports.SubmitKycDto = void 0;
const class_validator_1 = require("class-validator");
const swagger_1 = require("@nestjs/swagger");
class SubmitKycDto {
}
exports.SubmitKycDto = SubmitKycDto;
__decorate([
    (0, swagger_1.ApiProperty)({
        description: 'S3 fileKey from confirmed KTP upload (format: uploads/kyc-ktp/{userId}/{filename})',
        example: 'uploads/kyc-ktp/user123/1700000000_abc123.jpg',
    }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.Matches)(/^uploads\/kyc-ktp\/[^/]+\/[^/]+$/, {
        message: 'ktpFileKey must be a valid S3 key from a confirmed upload',
    }),
    __metadata("design:type", String)
], SubmitKycDto.prototype, "ktpFileKey", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({
        description: 'S3 fileKey from confirmed selfie upload (format: uploads/kyc-selfie/{userId}/{filename})',
        example: 'uploads/kyc-selfie/user123/1700000000_def456.jpg',
    }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.Matches)(/^uploads\/kyc-selfie\/[^/]+\/[^/]+$/, {
        message: 'selfieFileKey must be a valid S3 key from a confirmed upload',
    }),
    __metadata("design:type", String)
], SubmitKycDto.prototype, "selfieFileKey", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'NIK (exactly 16 digits)', pattern: '^\\d{16}$' }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.Matches)(/^\d{16}$/, { message: 'NIK must be exactly 16 digits' }),
    __metadata("design:type", String)
], SubmitKycDto.prototype, "nik", void 0);
