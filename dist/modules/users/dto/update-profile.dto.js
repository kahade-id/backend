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
exports.UpdateProfileDto = void 0;
const class_validator_1 = require("class-validator");
const swagger_1 = require("@nestjs/swagger");
const client_1 = require("@prisma/client");
class UpdateProfileDto {
}
exports.UpdateProfileDto = UpdateProfileDto;
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Full name', minLength: 2, maxLength: 60 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(2, { message: 'Name must be at least 2 characters' }),
    (0, class_validator_1.MaxLength)(60, { message: 'Name must be at most 60 characters' }),
    (0, class_validator_1.Matches)(/^[^<>]*$/, { message: 'Name must not contain < or > characters' }),
    __metadata("design:type", String)
], UpdateProfileDto.prototype, "fullName", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Username (can be changed once per month)', minLength: 3, maxLength: 30 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(3, { message: 'Username must be at least 3 characters' }),
    (0, class_validator_1.MaxLength)(30, { message: 'Username must be at most 30 characters' }),
    (0, class_validator_1.Matches)(/^[a-zA-Z0-9._]+$/, { message: 'Username may only contain letters, numbers, dots, and underscores' }),
    __metadata("design:type", String)
], UpdateProfileDto.prototype, "username", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'User bio', minLength: 0, maxLength: 500 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(500, { message: 'Bio must be at most 500 characters' }),
    (0, class_validator_1.Matches)(/^[^<>]*$/, { message: 'Bio must not contain < or > characters' }),
    __metadata("design:type", String)
], UpdateProfileDto.prototype, "bio", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ enum: client_1.UserAccountType, description: 'Account type' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(client_1.UserAccountType, { message: 'accountType must be PERSONAL or BUSINESS' }),
    __metadata("design:type", String)
], UpdateProfileDto.prototype, "accountType", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Phone number' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(20, { message: 'Phone number must be at most 20 characters' }),
    __metadata("design:type", String)
], UpdateProfileDto.prototype, "phoneNumber", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Date of birth (ISO date string)' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsDateString)({}, { message: 'Invalid date of birth format (use YYYY-MM-DD)' }),
    (0, class_validator_1.Matches)(/^\d{4}-\d{2}-\d{2}$/, { message: 'Date of birth must be in YYYY-MM-DD format' }),
    __metadata("design:type", String)
], UpdateProfileDto.prototype, "dateOfBirth", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Gender' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsEnum)(['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY'], { message: 'Gender must be MALE, FEMALE, OTHER, or PREFER_NOT_TO_SAY' }),
    __metadata("design:type", String)
], UpdateProfileDto.prototype, "gender", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Contact email (public)' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEmail)({}, { message: 'Invalid contact email format' }),
    __metadata("design:type", String)
], UpdateProfileDto.prototype, "contactEmail", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Contact phone (public)' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(20, { message: 'Contact phone must be at most 20 characters' }),
    __metadata("design:type", String)
], UpdateProfileDto.prototype, "contactPhone", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Show contact email on profile' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], UpdateProfileDto.prototype, "showContactEmail", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Show contact phone on profile' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], UpdateProfileDto.prototype, "showContactPhone", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Profile visibility' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], UpdateProfileDto.prototype, "profileVisible", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Show online status' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], UpdateProfileDto.prototype, "showOnlineStatus", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Current password (required when changing username, phone, or contact info)' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateProfileDto.prototype, "currentPassword", void 0);
