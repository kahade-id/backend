import { IsString, IsOptional, IsEnum, IsArray, IsIn, ValidateNested, MaxLength, IsInt, Min, Max, ArrayMaxSize, Matches } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum UserChatMessageType {
  TEXT = 'TEXT',
  IMAGE = 'IMAGE',
  FILE = 'FILE',
}

const ALLOWED_CHAT_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic',
  'video/mp4', 'video/quicktime', 'video/webm',
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/aac', 'audio/mp4', 'audio/m4a',
  'application/pdf',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
] as const;

export class ChatAttachmentDto {
  @ApiProperty({ description: 'File name', maxLength: 255 })
  @IsString()
  @MaxLength(255)
  fileName!: string;

  @ApiProperty({ description: 'File URL (must be HTTPS; trusted storage domain enforced at service layer)', maxLength: 512 })
  @IsString()
  @MaxLength(512)
  @Matches(/^https:\/\//, { message: 'fileUrl must be a valid HTTPS URL' })
  fileUrl!: string;

  @ApiProperty({ description: 'MIME type' })
  @IsIn([...ALLOWED_CHAT_MIME_TYPES], { message: 'Unsupported file type' })
  mimeType!: string;

  @ApiPropertyOptional({ description: 'Thumbnail URL (must be HTTPS; trusted storage domain enforced at service layer)', maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  @Matches(/^https:\/\//, { message: 'thumbnailUrl must be a valid HTTPS URL' })
  thumbnailUrl?: string;

  @ApiProperty({ description: 'File size in bytes', minimum: 1, maximum: 10485760 })
  @IsInt()
  @Min(1)
  @Max(10485760)
  fileSize!: number;
}

export class SendMessageDto {
  @ApiPropertyOptional({ enum: UserChatMessageType, description: 'Message type (TEXT, IMAGE, or FILE). SYSTEM is reserved for internal use.', default: 'TEXT' })
  @IsOptional()
  @IsEnum(UserChatMessageType)
  messageType?: UserChatMessageType = UserChatMessageType.TEXT;

  @ApiPropertyOptional({ description: 'Message content', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  content?: string;

  @ApiPropertyOptional({ description: 'Message attachments', type: [ChatAttachmentDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10, { message: 'Maximum 10 attachments per message' })
  @ValidateNested({ each: true })
  @Type(() => ChatAttachmentDto)
  attachments?: ChatAttachmentDto[];

  @ApiPropertyOptional({ description: 'ID of the message being replied to' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9]+$/, { message: 'replyToId must be a valid CUID' })
  @MaxLength(100)
  replyToId?: string;
}
