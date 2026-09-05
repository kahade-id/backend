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
exports.UpdatePreferencesDto = void 0;
const class_validator_1 = require("class-validator");
const swagger_1 = require("@nestjs/swagger");
class UpdatePreferencesDto {
}
exports.UpdatePreferencesDto = UpdatePreferencesDto;
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Order in-app notifications' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], UpdatePreferencesDto.prototype, "orderInApp", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Order push notifications' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], UpdatePreferencesDto.prototype, "orderPush", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Order email notifications' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], UpdatePreferencesDto.prototype, "orderEmail", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Wallet in-app notifications' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], UpdatePreferencesDto.prototype, "walletInApp", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Wallet push notifications' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], UpdatePreferencesDto.prototype, "walletPush", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Wallet email notifications' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], UpdatePreferencesDto.prototype, "walletEmail", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Security in-app notifications' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], UpdatePreferencesDto.prototype, "securityInApp", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Security push notifications' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], UpdatePreferencesDto.prototype, "securityPush", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Security email notifications' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], UpdatePreferencesDto.prototype, "securityEmail", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Chat in-app notifications' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], UpdatePreferencesDto.prototype, "chatInApp", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Chat push notifications' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], UpdatePreferencesDto.prototype, "chatPush", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Dispute in-app notifications' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], UpdatePreferencesDto.prototype, "disputeInApp", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Dispute push notifications' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], UpdatePreferencesDto.prototype, "disputePush", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Dispute email notifications' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], UpdatePreferencesDto.prototype, "disputeEmail", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Ranking in-app notifications' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], UpdatePreferencesDto.prototype, "rankingInApp", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Ranking push notifications' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], UpdatePreferencesDto.prototype, "rankingPush", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Marketing email notifications' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], UpdatePreferencesDto.prototype, "marketingEmail", void 0);
