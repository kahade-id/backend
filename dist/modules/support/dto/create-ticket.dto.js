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
exports.ReplyTicketDto = exports.CreateTicketDto = exports.TicketCategory = void 0;
const swagger_1 = require("@nestjs/swagger");
const class_validator_1 = require("class-validator");
const is_valid_id_decorator_1 = require("../../../common/decorators/is-valid-id.decorator");
var TicketCategory;
(function (TicketCategory) {
    TicketCategory["GENERAL"] = "GENERAL";
    TicketCategory["ORDER"] = "ORDER";
    TicketCategory["PAYMENT"] = "PAYMENT";
    TicketCategory["ACCOUNT"] = "ACCOUNT";
    TicketCategory["KYC"] = "KYC";
    TicketCategory["TECHNICAL"] = "TECHNICAL";
    TicketCategory["OTHER"] = "OTHER";
})(TicketCategory || (exports.TicketCategory = TicketCategory = {}));
class CreateTicketDto {
}
exports.CreateTicketDto = CreateTicketDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.MinLength)(1),
    (0, class_validator_1.MaxLength)(200),
    (0, class_validator_1.Matches)(/\S/, { message: 'subject cannot be blank' }),
    __metadata("design:type", String)
], CreateTicketDto.prototype, "subject", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.MinLength)(1),
    (0, class_validator_1.MaxLength)(5000),
    (0, class_validator_1.Matches)(/\S/, { message: 'message cannot be blank' }),
    __metadata("design:type", String)
], CreateTicketDto.prototype, "message", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(TicketCategory),
    __metadata("design:type", String)
], CreateTicketDto.prototype, "category", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, is_valid_id_decorator_1.IsValidId)(),
    __metadata("design:type", String)
], CreateTicketDto.prototype, "orderId", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Attachment file keys (max 5)', type: [String] }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ArrayMaxSize)(5, { message: 'Maximum 5 attachments per support ticket' }),
    (0, class_validator_1.IsString)({ each: true }),
    (0, class_validator_1.MaxLength)(512, { each: true }),
    (0, class_validator_1.Matches)(/^uploads\/[a-z-]+\/[A-Za-z0-9_-]+\/[\w.-]+$/, { each: true, message: 'Invalid attachment file key' }),
    __metadata("design:type", Array)
], CreateTicketDto.prototype, "attachments", void 0);
class ReplyTicketDto {
}
exports.ReplyTicketDto = ReplyTicketDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.MinLength)(1),
    (0, class_validator_1.MaxLength)(5000),
    (0, class_validator_1.Matches)(/\S/, { message: 'message cannot be blank' }),
    __metadata("design:type", String)
], ReplyTicketDto.prototype, "message", void 0);
