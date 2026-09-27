import {
  IsString,
  IsOptional,
  IsEnum,
  IsArray,
  IsIn,
  ValidateNested,
  MaxLength,
  IsInt,
  IsNumber,
  IsBoolean,
  Min,
  Max,
  ArrayMaxSize,
  ArrayMinSize,
  Matches,
} from 'class-validator';
import {
  CHAT_VOICE_MAX_DURATION_SECONDS,
  CHAT_VOICE_MIN_DURATION_SECONDS,
} from '../../../common/constants/app.constants';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum UserChatMessageType {
  TEXT = 'TEXT',
  IMAGE = 'IMAGE',
  FILE = 'FILE',
  /** Video message — with optional caption */
  VIDEO = 'VIDEO',
  /** Voice note — wajib lampiran audio + durationSeconds. */
  VOICE = 'VOICE',
  /** Batch 43 BE-CHAT: pesan lokasi {lat, lng, label?}. */
  LOCATION = 'LOCATION',
  /** Batch 43 BE-CHAT: kartu produk {showcaseId} + snapshot saat kirim. */
  PRODUCT_CARD = 'PRODUCT_CARD',
  /** Batch 43 BE-CHAT: kartu order {orderId} + snapshot saat kirim. */
  ORDER_CARD = 'ORDER_CARD',
}

const ALLOWED_CHAT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/aac',
  'audio/mp4',
  'audio/m4a',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
] as const;

/** Batch 43 BE-CHAT: koordinat untuk pesan LOCATION. */
export class ChatLocationDto {
  @ApiProperty({ description: 'Lintang (-90..90)', minimum: -90, maximum: 90 })
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @ApiProperty({ description: 'Bujur (-180..180)', minimum: -180, maximum: 180 })
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;

  @ApiPropertyOptional({ description: 'Label lokasi', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  label?: string;
}

export class ChatAttachmentDto {
  @ApiProperty({ description: 'File name', maxLength: 255 })
  @IsString()
  @MaxLength(255)
  fileName!: string;

  @ApiProperty({
    description: 'File URL (must be HTTPS; trusted storage domain enforced at service layer)',
    maxLength: 512,
  })
  @IsString()
  @MaxLength(512)
  @Matches(/^https:\/\//, { message: 'fileUrl must be a valid HTTPS URL' })
  fileUrl!: string;

  @ApiProperty({ description: 'MIME type' })
  @IsIn([...ALLOWED_CHAT_MIME_TYPES], { message: 'Unsupported file type' })
  mimeType!: string;

  @ApiPropertyOptional({
    description: 'Thumbnail URL (must be HTTPS; trusted storage domain enforced at service layer)',
    maxLength: 512,
  })
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
  @ApiPropertyOptional({
    enum: UserChatMessageType,
    description: 'Message type (TEXT, IMAGE, FILE, or VOICE). SYSTEM is reserved for internal use.',
    default: 'TEXT',
  })
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

  @ApiPropertyOptional({
    description: 'Voice note duration in seconds. Required for VOICE messages.',
    minimum: CHAT_VOICE_MIN_DURATION_SECONDS,
    maximum: CHAT_VOICE_MAX_DURATION_SECONDS,
  })
  @IsOptional()
  @IsInt()
  @Min(CHAT_VOICE_MIN_DURATION_SECONDS)
  @Max(CHAT_VOICE_MAX_DURATION_SECONDS)
  durationSeconds?: number;

  @ApiPropertyOptional({ description: 'Caption for image/video attachments', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  caption?: string;

  @ApiPropertyOptional({ description: 'Lokasi untuk pesan LOCATION', type: ChatLocationDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ChatLocationDto)
  location?: ChatLocationDto;

  @ApiPropertyOptional({ description: 'ID etalase untuk pesan PRODUCT_CARD' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  showcaseId?: string;

  @ApiPropertyOptional({ description: 'ID order (cuid) untuk pesan ORDER_CARD' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  orderId?: string;

  @ApiPropertyOptional({
    description: 'TTL pesan sementara dalam detik (5–604800). Pesan dihapus permanen setelah kedaluwarsa.',
    minimum: 5,
    maximum: 604800,
  })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(604800)
  ephemeralTtlSeconds?: number;

  @ApiPropertyOptional({
    description: 'Pesan sekali lihat — hilang setelah dibaca lawan bicara.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  viewOnce?: boolean;
}
