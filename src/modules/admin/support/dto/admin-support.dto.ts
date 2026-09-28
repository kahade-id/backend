import { IsString, IsOptional, IsIn, IsBoolean, IsArray, MinLength, MaxLength, IsInt, Min, Matches, ArrayMaxSize } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;
const TICKET_CATEGORIES = ['GENERAL', 'ORDER', 'PAYMENT', 'ACCOUNT', 'KYC', 'TECHNICAL', 'OTHER'] as const;

const toBoolean = ({ value }: { value: unknown }) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.toLowerCase();
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
  }
  return value;
};

export class AdminTicketQueryDto {
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
  @ApiPropertyOptional({ enum: TICKET_STATUSES }) @IsOptional() @IsIn(TICKET_STATUSES as unknown as string[]) status?: string;
  @ApiPropertyOptional({ enum: TICKET_CATEGORIES }) @IsOptional() @IsIn(TICKET_CATEGORIES as unknown as string[]) category?: string;
  @ApiPropertyOptional({ maxLength: 200 }) @IsOptional() @IsString() @MaxLength(200) search?: string;
  @ApiPropertyOptional({ description: 'Filter tiket prioritas (subscriber Kahade+ aktif)' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  priority?: boolean;
}

export class AdminTicketReplyDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(4000) @Matches(/\S/, { message: 'message cannot be blank' }) message!: string;

  // BE-IMP (item 130): lampiran pada balasan tiket oleh admin. Validasi sama
  // dengan balasan user (maks 5, format file key uploads/...).
  @ApiPropertyOptional({ description: 'Attachment file keys (max 5)', type: [String] })
  @IsOptional() @IsArray() @ArrayMaxSize(5, { message: 'Maximum 5 attachments per ticket reply' }) @IsString({ each: true }) @MaxLength(512, { each: true }) @Matches(/^uploads\/[a-z-]+\/[A-Za-z0-9_-]+\/[\w.-]+$/, { each: true, message: 'Invalid attachment file key' })
  attachments?: string[];
}

export class AdminTicketStatusDto {
  @ApiProperty({ enum: TICKET_STATUSES }) @IsIn(TICKET_STATUSES as unknown as string[]) status!: string;
}
