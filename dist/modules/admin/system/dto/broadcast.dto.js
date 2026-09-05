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
exports.BroadcastDto = void 0;
const class_validator_1 = require("class-validator");
const swagger_1 = require("@nestjs/swagger");
class BroadcastDto {
}
exports.BroadcastDto = BroadcastDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Broadcast title', maxLength: 100 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.MinLength)(3),
    (0, class_validator_1.Matches)(/\S/),
    (0, class_validator_1.MaxLength)(100),
    __metadata("design:type", String)
], BroadcastDto.prototype, "title", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Broadcast body/message', maxLength: 500 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.MinLength)(3),
    (0, class_validator_1.Matches)(/\S/),
    (0, class_validator_1.MaxLength)(500),
    __metadata("design:type", String)
], BroadcastDto.prototype, "body", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Delivery channels. Push uses registered native FCM tokens.', enum: ['in_app', 'push'], isArray: true, example: ['in_app', 'push'] }),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ArrayMinSize)(1),
    (0, class_validator_1.ArrayUnique)(),
    (0, class_validator_1.ArrayMaxSize)(2, { message: 'At most in_app and push may be selected' }),
    (0, class_validator_1.IsString)({ each: true }),
    (0, class_validator_1.IsIn)(['in_app', 'push'], { each: true, message: 'Supported channels are in_app and push' }),
    __metadata("design:type", Array)
], BroadcastDto.prototype, "channels", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Target audience filter', enum: ['all', 'active', 'kahade_plus', 'verified'] }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsIn)(['all', 'active', 'kahade_plus', 'verified']),
    __metadata("design:type", String)
], BroadcastDto.prototype, "targetAudience", void 0);
