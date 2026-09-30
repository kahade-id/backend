import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { FeedbackCloseReason, FeedbackRisk, FeedbackStatus } from '@prisma/client';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.toLowerCase();
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
  }
  return value;
};

export class AdminFeedbackQueryDto {
  @ApiPropertyOptional({ description: 'Filter kategori' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  category?: string;

  @ApiPropertyOptional({ description: 'Filter platform pengirim' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(32)
  platform?: string;

  @ApiPropertyOptional({ description: 'Filter rating 1-5', minimum: 1, maximum: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @ApiPropertyOptional({ enum: FeedbackStatus, description: 'Filter status workflow' })
  @IsOptional()
  @IsEnum(FeedbackStatus)
  status?: FeedbackStatus;

  @ApiPropertyOptional({ enum: ['user', 'guest'], description: 'Filter akun terdaftar vs guest' })
  @IsOptional()
  @IsIn(['user', 'guest'])
  account?: 'user' | 'guest';

  @ApiPropertyOptional({ description: 'Batas bawah tanggal dibuat (ISO)' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ description: 'Batas atas tanggal dibuat (ISO)' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiPropertyOptional({ description: 'Pencarian teks aman di message & kategori', maxLength: 200 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ description: 'Cursor halaman berikutnya (opaque)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cursor?: string;

  @ApiPropertyOptional({ description: 'Jumlah baris per halaman', default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class AdminFeedbackStatusDto {
  @ApiProperty({ enum: FeedbackStatus, description: 'Status tujuan' })
  @IsEnum(FeedbackStatus)
  status!: FeedbackStatus;

  @ApiPropertyOptional({
    enum: FeedbackCloseReason,
    description: 'Wajib bila status tujuan CLOSED',
  })
  @IsOptional()
  @IsEnum(FeedbackCloseReason)
  reason?: FeedbackCloseReason;
}

export class AdminFeedbackAssignDto {
  @ApiProperty({ description: 'ID admin yang ditugaskan' })
  @IsString()
  @MaxLength(100)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: 'adminId format tidak valid' })
  adminId!: string;

  @ApiPropertyOptional({ description: 'Catatan penugasan (opsional)', maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class AdminFeedbackNoteDto {
  @ApiProperty({ description: 'Catatan internal — tidak pernah dikirim ke user', maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  @Matches(/\S/, { message: 'note cannot be blank' })
  note!: string;
}

export class AdminFeedbackTagsDto {
  @ApiProperty({ description: 'Tag tema (1–20)', type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(50, { each: true })
  tags!: string[];

  @ApiPropertyOptional({ description: 'Label dampak', maxLength: 50 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(50)
  impactLabel?: string;
}

export class AdminFeedbackReplyDto {
  @ApiProperty({ description: 'Isi balasan ke pengirim', maxLength: 4000 })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  @Matches(/\S/, { message: 'body cannot be blank' })
  body!: string;
}

export class AdminFeedbackEscalateDto {
  @ApiProperty({ enum: [FeedbackRisk.SECURITY_RISK, FeedbackRisk.FRAUD_RISK] })
  @IsEnum(FeedbackRisk)
  risk!: FeedbackRisk;

  @ApiPropertyOptional({ description: 'Catatan eskalasi (opsional)', maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class AdminFeedbackCloseDto {
  @ApiProperty({ enum: FeedbackCloseReason, description: 'Kode alasan penutupan (wajib)' })
  @IsEnum(FeedbackCloseReason)
  reason!: FeedbackCloseReason;
}

export class AdminFeedbackSlaRuleDto {
  @ApiProperty({ description: 'Kategori feedback', maxLength: 100 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  category!: string;

  @ApiProperty({ description: 'Batas SLA dalam jam', minimum: 1, maximum: 720 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(720)
  hours!: number;

  @ApiPropertyOptional({ description: 'Tandai kategori kritis', default: false })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isCritical?: boolean;
}

// BAI-001: DTO update parsial aturan SLA — validasi identik dengan create,
// tetapi semua field opsional (PATCH).
export class UpdateAdminFeedbackSlaRuleDto {
  @ApiPropertyOptional({ description: 'Kategori feedback', maxLength: 100 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  category?: string;

  @ApiPropertyOptional({ description: 'Batas SLA dalam jam', minimum: 1, maximum: 720 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(720)
  hours?: number;

  @ApiPropertyOptional({ description: 'Tandai kategori kritis', default: false })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isCritical?: boolean;
}

export class AdminFeedbackExportDto {
  @ApiPropertyOptional({ enum: ['json', 'csv'], default: 'json' })
  @IsOptional()
  @IsIn(['json', 'csv'])
  format?: 'json' | 'csv';
}
