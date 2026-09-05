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
exports.SetUsernameDto = void 0;
const class_validator_1 = require("class-validator");
const swagger_1 = require("@nestjs/swagger");
const class_transformer_1 = require("class-transformer");
const USERNAME_REGEX = /^[a-z0-9_]{3,20}$/;
const USERNAME_MSG = 'Username must be 3-20 characters and contain only lowercase letters, digits, and underscores';
class SetUsernameDto {
}
exports.SetUsernameDto = SetUsernameDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Unique username (3-20 characters)', minLength: 3, maxLength: 20 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(3),
    (0, class_validator_1.MaxLength)(20),
    (0, class_validator_1.Matches)(USERNAME_REGEX, { message: USERNAME_MSG }),
    (0, class_transformer_1.Transform)(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value)),
    __metadata("design:type", String)
], SetUsernameDto.prototype, "username", void 0);
