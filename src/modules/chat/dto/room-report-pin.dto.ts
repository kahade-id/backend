import { IsString, IsOptional, IsEnum, IsArray, IsInt, Min, Max, IsNotEmpty, MinLength, MaxLength, ArrayMaxSize, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReportCategory } from '@prisma/client';

/** Batch 43 BE-CHAT: laporkan lawan bicara dari menu room. */
export class ReportRoomDto {
  @ApiProperty({ enum: ReportCategory, description: 'Kategori laporan' })
  @IsEnum(ReportCategory, { message: 'Invalid report category' })
  category!: ReportCategory;

  @ApiProperty({ description: 'Alasan laporan', minLength: 20, maxLength: 500 })
  @IsString()
  @IsNotEmpty({ message: 'Report description is required' })
  @MinLength(20, { message: 'Report reason must be at least 20 characters to provide sufficient context' })
  @MaxLength(500, { message: 'Description must be at most 500 characters' })
  description!: string;

  @ApiPropertyOptional({ description: 'URL bukti (storage platform)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10, { message: 'Maximum 10 evidence URLs' })
  @Matches(/^https:\/\//, { each: true, message: 'Evidence URLs must be HTTPS' })
  @MaxLength(500, { each: true })
  evidenceUrls?: string[];

  @ApiPropertyOptional({ description: 'ID pesan terkait (opsional, untuk konteks admin)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  relatedMessageId?: string;
}

/** Batch 43 BE-CHAT: pin room (per user, tersinkron backend). */
export class PinRoomDto {
  @ApiPropertyOptional({ description: 'Posisi urutan (kecil = paling atas)', default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  position?: number;
}
