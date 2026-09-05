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
exports.UpdateLinksDto = exports.UserLinkItemDto = void 0;
const class_validator_1 = require("class-validator");
const swagger_1 = require("@nestjs/swagger");
const class_transformer_1 = require("class-transformer");
class UserLinkItemDto {
}
exports.UserLinkItemDto = UserLinkItemDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Platform name (e.g. instagram, twitter, website)', maxLength: 30 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.MaxLength)(30),
    __metadata("design:type", String)
], UserLinkItemDto.prototype, "platform", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Link URL', maxLength: 500 }),
    (0, class_validator_1.IsUrl)({ protocols: ['https'] }, { message: 'Invalid URL — only HTTPS allowed' }),
    (0, class_validator_1.MaxLength)(500),
    __metadata("design:type", String)
], UserLinkItemDto.prototype, "url", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Display label', maxLength: 50 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(50),
    __metadata("design:type", String)
], UserLinkItemDto.prototype, "label", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Display order' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(0),
    (0, class_validator_1.Max)(20),
    __metadata("design:type", Number)
], UserLinkItemDto.prototype, "displayOrder", void 0);
class UpdateLinksDto {
}
exports.UpdateLinksDto = UpdateLinksDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Array of links (replaces all existing)', type: [UserLinkItemDto] }),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ArrayMaxSize)(10, { message: 'Maximum 10 links' }),
    (0, class_validator_1.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => UserLinkItemDto),
    __metadata("design:type", Array)
], UpdateLinksDto.prototype, "links", void 0);
