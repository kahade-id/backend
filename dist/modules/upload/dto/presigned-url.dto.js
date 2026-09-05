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
exports.PresignedUrlDto = exports.UploadPurpose = void 0;
const class_validator_1 = require("class-validator");
const swagger_1 = require("@nestjs/swagger");
var UploadPurpose;
(function (UploadPurpose) {
    UploadPurpose["KYC_KTP"] = "KYC_KTP";
    UploadPurpose["KYC_SELFIE"] = "KYC_SELFIE";
    UploadPurpose["AVATAR"] = "AVATAR";
    UploadPurpose["CHAT_ATTACHMENT"] = "CHAT_ATTACHMENT";
    UploadPurpose["DISPUTE_EVIDENCE"] = "DISPUTE_EVIDENCE";
    UploadPurpose["REPORT_EVIDENCE"] = "REPORT_EVIDENCE";
    UploadPurpose["DELIVERY_PROOF"] = "DELIVERY_PROOF";
})(UploadPurpose || (exports.UploadPurpose = UploadPurpose = {}));
class PresignedUrlDto {
}
exports.PresignedUrlDto = PresignedUrlDto;
__decorate([
    (0, swagger_1.ApiProperty)({
        enum: UploadPurpose,
        description: 'Upload purpose determines allowed content types, max file size, and URL expiry duration',
    }),
    (0, class_validator_1.IsEnum)(UploadPurpose),
    __metadata("design:type", String)
], PresignedUrlDto.prototype, "purpose", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ example: 'photo.jpg' }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.MaxLength)(255),
    __metadata("design:type", String)
], PresignedUrlDto.prototype, "fileName", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ example: 'image/jpeg' }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.MaxLength)(100),
    __metadata("design:type", String)
], PresignedUrlDto.prototype, "contentType", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ example: 102400, description: 'Exact file size in bytes. Must be within the allowed range for the upload purpose.' }),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1024),
    __metadata("design:type", Number)
], PresignedUrlDto.prototype, "fileSize", void 0);
