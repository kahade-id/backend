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
exports.ConfirmPhoneChangeDto = exports.RequestPhoneChangeDto = void 0;
const class_validator_1 = require("class-validator");
class RequestPhoneChangeDto {
}
exports.RequestPhoneChangeDto = RequestPhoneChangeDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(20),
    __metadata("design:type", String)
], RequestPhoneChangeDto.prototype, "newPhoneNumber", void 0);
__decorate([
    (0, class_validator_1.IsIn)(['SMS', 'WHATSAPP']),
    __metadata("design:type", String)
], RequestPhoneChangeDto.prototype, "method", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(1),
    (0, class_validator_1.MaxLength)(256),
    __metadata("design:type", String)
], RequestPhoneChangeDto.prototype, "currentPassword", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(16),
    (0, class_validator_1.Matches)(/^(?:\d{6}|[A-Za-z0-9]{10,16})$/, {
        message: 'mfaCode must be a six-digit authenticator code or a 10–16 character backup code',
    }),
    __metadata("design:type", String)
], RequestPhoneChangeDto.prototype, "mfaCode", void 0);
class ConfirmPhoneChangeDto {
}
exports.ConfirmPhoneChangeDto = ConfirmPhoneChangeDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(20),
    __metadata("design:type", String)
], ConfirmPhoneChangeDto.prototype, "newPhoneNumber", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.Matches)(/^\d{6}$/),
    __metadata("design:type", String)
], ConfirmPhoneChangeDto.prototype, "code", void 0);
