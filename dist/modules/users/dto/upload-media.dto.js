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
exports.AnswerQuestionDto = exports.AskQuestionDto = exports.AccountDeletionDto = exports.ConfirmHeaderDto = exports.UploadMediaDto = void 0;
const class_validator_1 = require("class-validator");
const swagger_1 = require("@nestjs/swagger");
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
class UploadMediaDto {
}
exports.UploadMediaDto = UploadMediaDto;
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Content type of the image', enum: ALLOWED_IMAGE_TYPES }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsIn)(ALLOWED_IMAGE_TYPES, { message: 'contentType must be image/jpeg, image/png, or image/webp' }),
    __metadata("design:type", String)
], UploadMediaDto.prototype, "contentType", void 0);
class ConfirmHeaderDto {
}
exports.ConfirmHeaderDto = ConfirmHeaderDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'S3 key of the uploaded header image' }),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], ConfirmHeaderDto.prototype, "headerKey", void 0);
class AccountDeletionDto {
}
exports.AccountDeletionDto = AccountDeletionDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'User password for confirmation' }),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], AccountDeletionDto.prototype, "password", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Reason for account deletion' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], AccountDeletionDto.prototype, "reason", void 0);
class AskQuestionDto {
}
exports.AskQuestionDto = AskQuestionDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Question text' }),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], AskQuestionDto.prototype, "question", void 0);
class AnswerQuestionDto {
}
exports.AnswerQuestionDto = AnswerQuestionDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Answer text' }),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], AnswerQuestionDto.prototype, "answer", void 0);
