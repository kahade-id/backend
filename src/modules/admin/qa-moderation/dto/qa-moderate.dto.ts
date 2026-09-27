import { IsIn, IsOptional, IsString, MaxLength, IsBoolean, IsArray, ArrayMaxSize, ArrayMinSize } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { QA_MODERATION_REASONS, QA_REPORT_TARGETS } from '../qa-moderation.types';

export class QaModeratorHideDto {
  @ApiProperty({
    description: 'Reason code moderator platform (G429).',
    enum: QA_MODERATION_REASONS,
  })
  @IsString()
  @IsIn(QA_MODERATION_REASONS as unknown as string[])
  reasonCode!: string;

  @ApiPropertyOptional({
    description: 'Catatan internal — HANYA terlihat admin, tidak pernah dikirim ke user.',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class QaModeratorUnhideDto {
  @ApiPropertyOptional({
    description: 'Catatan internal unhide (opsional) — HANYA terlihat admin.',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class QaBulkHideDto extends QaModeratorHideDto {
  @ApiProperty({ description: 'Tipe target.', enum: QA_REPORT_TARGETS })
  @IsString()
  @IsIn(QA_REPORT_TARGETS as unknown as string[])
  targetType!: string;

  @ApiProperty({ description: 'ID target (maks 50 per request).', type: [String], maxItems: 50 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  ids!: string[];

  @ApiProperty({
    description:
      'Konfirmasi eksplisit dari UI (checkbox "Saya yakin"). Wajib true — tanpa ini bulk ditolak (G441).',
  })
  @IsBoolean()
  confirm!: boolean;
}

export class QaBulkUnhideDto {
  @ApiProperty({ description: 'Tipe target.', enum: QA_REPORT_TARGETS })
  @IsString()
  @IsIn(QA_REPORT_TARGETS as unknown as string[])
  targetType!: string;

  @ApiProperty({ description: 'ID target (maks 50 per request).', type: [String], maxItems: 50 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  ids!: string[];

  @ApiProperty({ description: 'Konfirmasi eksplisit dari UI. Wajib true.' })
  @IsBoolean()
  confirm!: boolean;

  @ApiPropertyOptional({ description: 'Catatan internal (opsional).', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
