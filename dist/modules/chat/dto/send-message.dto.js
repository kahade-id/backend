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
exports.SendMessageDto = exports.ChatAttachmentDto = exports.UserChatMessageType = void 0;
const class_validator_1 = require("class-validator");
const class_transformer_1 = require("class-transformer");
const swagger_1 = require("@nestjs/swagger");
var UserChatMessageType;
(function (UserChatMessageType) {
    UserChatMessageType["TEXT"] = "TEXT";
    UserChatMessageType["IMAGE"] = "IMAGE";
    UserChatMessageType["FILE"] = "FILE";
})(UserChatMessageType || (exports.UserChatMessageType = UserChatMessageType = {}));
const ALLOWED_CHAT_MIME_TYPES = [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic',
    'video/mp4', 'video/quicktime', 'video/webm',
    'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/aac', 'audio/mp4', 'audio/m4a',
    'application/pdf',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
];
class ChatAttachmentDto {
}
exports.ChatAttachmentDto = ChatAttachmentDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'File name', maxLength: 255 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(255),
    __metadata("design:type", String)
], ChatAttachmentDto.prototype, "fileName", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'File URL (must be HTTPS; trusted storage domain enforced at service layer)', maxLength: 512 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(512),
    (0, class_validator_1.Matches)(/^https:\/\//, { message: 'fileUrl must be a valid HTTPS URL' }),
    __metadata("design:type", String)
], ChatAttachmentDto.prototype, "fileUrl", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'MIME type' }),
    (0, class_validator_1.IsIn)([...ALLOWED_CHAT_MIME_TYPES], { message: 'Unsupported file type' }),
    __metadata("design:type", String)
], ChatAttachmentDto.prototype, "mimeType", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Thumbnail URL (must be HTTPS; trusted storage domain enforced at service layer)', maxLength: 512 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(512),
    (0, class_validator_1.Matches)(/^https:\/\//, { message: 'thumbnailUrl must be a valid HTTPS URL' }),
    __metadata("design:type", String)
], ChatAttachmentDto.prototype, "thumbnailUrl", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'File size in bytes', minimum: 1, maximum: 10485760 }),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(10485760),
    __metadata("design:type", Number)
], ChatAttachmentDto.prototype, "fileSize", void 0);
class SendMessageDto {
    constructor() {
        this.messageType = UserChatMessageType.TEXT;
    }
}
exports.SendMessageDto = SendMessageDto;
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ enum: UserChatMessageType, description: 'Message type (TEXT, IMAGE, or FILE). SYSTEM is reserved for internal use.', default: 'TEXT' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(UserChatMessageType),
    __metadata("design:type", String)
], SendMessageDto.prototype, "messageType", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Message content', maxLength: 2000 }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(2000),
    __metadata("design:type", String)
], SendMessageDto.prototype, "content", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Message attachments', type: [ChatAttachmentDto] }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ArrayMaxSize)(10, { message: 'Maximum 10 attachments per message' }),
    (0, class_validator_1.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => ChatAttachmentDto),
    __metadata("design:type", Array)
], SendMessageDto.prototype, "attachments", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'ID of the message being replied to' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.Matches)(/^[a-z0-9]+$/, { message: 'replyToId must be a valid CUID' }),
    (0, class_validator_1.MaxLength)(100),
    __metadata("design:type", String)
], SendMessageDto.prototype, "replyToId", void 0);
