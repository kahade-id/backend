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
exports.AddCommentDto = exports.AnswerQuestionDto = exports.AskQuestionDto = void 0;
const class_validator_1 = require("class-validator");
const is_valid_id_decorator_1 = require("../../../common/decorators/is-valid-id.decorator");
const swagger_1 = require("@nestjs/swagger");
class AskQuestionDto {
}
exports.AskQuestionDto = AskQuestionDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Question content', minLength: 5, maxLength: 500 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(5, { message: 'Question must be at least 5 characters' }),
    (0, class_validator_1.MaxLength)(500),
    __metadata("design:type", String)
], AskQuestionDto.prototype, "question", void 0);
class AnswerQuestionDto {
}
exports.AnswerQuestionDto = AnswerQuestionDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Answer content', minLength: 1, maxLength: 2000 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(1, { message: 'Answer is required' }),
    (0, class_validator_1.MaxLength)(2000),
    __metadata("design:type", String)
], AnswerQuestionDto.prototype, "answer", void 0);
class AddCommentDto {
}
exports.AddCommentDto = AddCommentDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Comment content', minLength: 1, maxLength: 1000 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(1, { message: 'Comment is required' }),
    (0, class_validator_1.MaxLength)(1000),
    __metadata("design:type", String)
], AddCommentDto.prototype, "content", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Parent comment ID for threaded replies' }),
    (0, class_validator_1.IsOptional)(),
    (0, is_valid_id_decorator_1.IsValidId)(),
    __metadata("design:type", String)
], AddCommentDto.prototype, "parentId", void 0);
