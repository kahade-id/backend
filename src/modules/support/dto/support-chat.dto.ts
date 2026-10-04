import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, ArrayMaxSize, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import { IsValidId } from '../../../common/decorators/is-valid-id.decorator';

/** Kanal asal percakapan livechat: aplikasi mobile atau bantuan.kahade.id. */
export enum SupportChatSource {
  APP = 'APP',
  HELP_SITE = 'HELP_SITE',
}

const ATTACHMENT_KEY_RE = /^uploads\/[a-z-]+\/[A-Za-z0-9_-]+\/[\w.-]+$/;

export class CreateConversationDto {
  @ApiPropertyOptional({ description: 'Kanal asal percakapan', enum: SupportChatSource, default: SupportChatSource.APP })
  @IsOptional() @IsEnum(SupportChatSource)
  source?: SupportChatSource;

  @ApiPropertyOptional({ description: 'Subjek/topik awal percakapan (maks 200 karakter)' })
  @IsOptional() @IsString() @MaxLength(200)
  subject?: string;
}

export class SendSupportMessageDto {
  @ApiPropertyOptional({ description: 'Isi pesan teks (maks 5000 karakter)' })
  @IsOptional() @IsString() @MaxLength(5000) @Matches(/\S/, { message: 'content cannot be blank' })
  content?: string;

  @ApiPropertyOptional({ description: 'Attachment file keys (max 5)', type: [String] })
  @IsOptional() @IsArray() @ArrayMaxSize(5, { message: 'Maximum 5 attachments per message' }) @IsString({ each: true }) @MaxLength(512, { each: true }) @Matches(ATTACHMENT_KEY_RE, { each: true, message: 'Invalid attachment file key' })
  attachments?: string[];
}

export class ClaimConversationDto {
  @ApiPropertyOptional({ description: 'ID agen tujuan (hanya SUPER_ADMIN; kosong = claim untuk diri sendiri)' })
  @IsOptional() @IsValidId()
  agentId?: string;
}

export class EscalateConversationDto {
  @IsString() @IsNotEmpty() @MinLength(1) @MaxLength(200) @Matches(/\S/, { message: 'subject cannot be blank' })
  subject!: string;

  @ApiPropertyOptional({ description: 'Kategori tiket', default: 'GENERAL' })
  @IsOptional() @IsString() @IsIn(['GENERAL', 'ORDER', 'PAYMENT', 'ACCOUNT', 'KYC', 'TECHNICAL', 'OTHER'])
  category?: string;

  @ApiPropertyOptional({ description: 'Ringkasan admin untuk tiket (maks 5000 karakter)' })
  @IsOptional() @IsString() @MaxLength(5000)
  message?: string;
}

export class RateConversationDto {
  @IsInt() @Min(1) @Max(5)
  @Type(() => Number)
  rating!: number;

  @ApiPropertyOptional({ description: 'Komentar penilaian (maks 1000 karakter)' })
  @IsOptional() @IsString() @MaxLength(1000)
  comment?: string;
}

export class SetAgentAvailabilityDto {
  @IsBoolean()
  available!: boolean;
}

export class ConversationQueryDto {
  @ApiPropertyOptional({ description: 'Filter status', enum: ['WAITING', 'ASSIGNED', 'OPEN', 'CLOSED'] })
  @IsOptional() @IsIn(['WAITING', 'ASSIGNED', 'OPEN', 'CLOSED'])
  status?: string;

  @IsOptional() @IsInt() @Min(1) @Type(() => Number)
  page?: number;

  @IsOptional() @IsInt() @Min(1) @Max(50) @Type(() => Number)
  limit?: number;
}
