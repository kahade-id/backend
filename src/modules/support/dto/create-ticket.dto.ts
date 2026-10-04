import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, ArrayMaxSize, MinLength } from 'class-validator';

// POIN 5 (2026-10-04): CreateTicketDto DICABUT — tiket HANYA dibuat admin via
// eskalasi livechat (SupportChatService.escalateToTicket). Endpoint user
// POST /v1/support/tickets dihapus dari SupportController.

export class ReplyTicketDto {
  @IsString() @IsNotEmpty() @MinLength(1) @MaxLength(5000) @Matches(/\S/, { message: 'message cannot be blank' })
  message!: string;

  // BE-IMP (item 130): lampiran pada balasan tiket. Validasi sama dengan
  // CreateTicketDto.attachments (maks 5, format file key uploads/...).
  @ApiPropertyOptional({ description: 'Attachment file keys (max 5)', type: [String] })
  @IsOptional() @IsArray() @ArrayMaxSize(5, { message: 'Maximum 5 attachments per ticket reply' }) @IsString({ each: true }) @MaxLength(512, { each: true }) @Matches(/^uploads\/[a-z-]+\/[A-Za-z0-9_-]+\/[\w.-]+$/, { each: true, message: 'Invalid attachment file key' })
  attachments?: string[];
}
