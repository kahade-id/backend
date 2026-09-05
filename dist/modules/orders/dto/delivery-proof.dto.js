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
exports.RejectDeliveryDto = exports.ConfirmDeliveryDto = exports.SubmitDeliveryProofDto = void 0;
const class_validator_1 = require("class-validator");
const swagger_1 = require("@nestjs/swagger");
class SubmitDeliveryProofDto {
}
exports.SubmitDeliveryProofDto = SubmitDeliveryProofDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Description of the delivery proof', minLength: 10, maxLength: 2000 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(10),
    (0, class_validator_1.MaxLength)(2000),
    __metadata("design:type", String)
], SubmitDeliveryProofDto.prototype, "description", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'S3 object keys for proof files', type: [String], maxItems: 10 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ArrayMaxSize)(10),
    (0, class_validator_1.IsString)({ each: true }),
    (0, class_validator_1.MaxLength)(512, { each: true }),
    (0, class_validator_1.Matches)(/^uploads\/delivery-proof\//, { each: true, message: 'Each fileUrl must be a valid delivery proof upload key' }),
    __metadata("design:type", Array)
], SubmitDeliveryProofDto.prototype, "fileUrls", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Link URLs for proof', type: [String], maxItems: 5 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ArrayMaxSize)(5),
    (0, class_validator_1.IsUrl)({ protocols: ['http', 'https'] }, { each: true, message: 'Each linkUrl must be a valid HTTP(S) URL' }),
    (0, class_validator_1.MaxLength)(1000, { each: true }),
    __metadata("design:type", Array)
], SubmitDeliveryProofDto.prototype, "linkUrls", void 0);
class ConfirmDeliveryDto {
}
exports.ConfirmDeliveryDto = ConfirmDeliveryDto;
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Specific submitted delivery proof to review' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.Matches)(/^c[a-z0-9]{24}$/, { message: 'proofId must be a valid delivery proof ID' }),
    __metadata("design:type", String)
], ConfirmDeliveryDto.prototype, "proofId", void 0);
class RejectDeliveryDto {
}
exports.RejectDeliveryDto = RejectDeliveryDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Reason for rejecting delivery', minLength: 10, maxLength: 1000 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(10),
    (0, class_validator_1.MaxLength)(1000),
    __metadata("design:type", String)
], RejectDeliveryDto.prototype, "note", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Specific submitted delivery proof to reject' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.Matches)(/^c[a-z0-9]{24}$/, { message: 'proofId must be a valid delivery proof ID' }),
    __metadata("design:type", String)
], RejectDeliveryDto.prototype, "proofId", void 0);
