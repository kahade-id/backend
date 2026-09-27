import { IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  SHOWCASE_SPIN360_GROUP_KEY_MAX_LENGTH,
  SHOWCASE_VIDEO_MAX_DURATION_SEC,
} from '../../../common/constants/app.constants';

/** Jenis media etalase (batch 19 TIM A, item 1 & 2). */
export enum ShowcaseMediaKind {
  IMAGE = 'image',
  VIDEO = 'video',
  SPIN360 = 'spin360',
}

/**
 * Satu entri media pada create/update etalase.
 *
 * - `image`: fileKey = upload confirmed purpose SHOWCASE_IMAGE.
 * - `video`: fileKey = upload confirmed purpose SHOWCASE_VIDEO; thumbnailFileKey
 *   = upload confirmed SHOWCASE_IMAGE milik user (boleh yang auto-generate saat
 *   upload video); durationSec/width/height diambil dari respons upload.
 * - `spin360`: fileKey = upload confirmed SHOWCASE_IMAGE; satu set 8–24 frame
 *   diikat `groupKey` yang sama dengan `groupOrder` 0..n-1 kontinu. Validasi
 *   grup (jumlah frame + kontinuitas order) dilakukan di service — fail closed.
 */
export class ShowcaseMediaInputDto {
  @ApiProperty({ description: 'Object key hasil upload yang sudah dikonfirmasi.' })
  @IsString()
  @MaxLength(512)
  fileKey!: string;

  @ApiProperty({ enum: ShowcaseMediaKind })
  @IsEnum(ShowcaseMediaKind)
  kind!: ShowcaseMediaKind;

  @ApiPropertyOptional({
    description: 'Wajib untuk kind=video: key thumbnail (confirmed SHOWCASE_IMAGE milik user).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  thumbnailFileKey?: string;

  @ApiPropertyOptional({ description: 'Durasi video detik (1–180).', minimum: 1, maximum: SHOWCASE_VIDEO_MAX_DURATION_SEC })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(SHOWCASE_VIDEO_MAX_DURATION_SEC)
  durationSec?: number;

  @ApiPropertyOptional({ description: 'Lebar video (px).', minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8192)
  width?: number;

  @ApiPropertyOptional({ description: 'Tinggi video (px).', minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8192)
  height?: number;

  @ApiPropertyOptional({
    description: 'Wajib untuk kind=spin360: pengikat frame satu set (alnum, dash, underscore).',
    maxLength: SHOWCASE_SPIN360_GROUP_KEY_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(SHOWCASE_SPIN360_GROUP_KEY_MAX_LENGTH)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: 'groupKey hanya boleh berisi huruf, angka, dash, underscore' })
  groupKey?: string;

  @ApiPropertyOptional({ description: 'Wajib untuk kind=spin360: urutan frame dalam grup, mulai dari 0.', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  groupOrder?: number;
}
