import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsObject, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SHOWCASE_MAX_IMAGES_ABSOLUTE } from '../../../common/constants/app.constants';

/**
 * Section 3 — manajemen gambar showcase (one-to-many).
 *
 * Semua key harus hasil upload presigned purpose SHOWCASE_IMAGE milik user yang
 * sama dan sudah dikonfirmasi lewat POST /upload/confirm; service memverifikasi
 * ulang ukuran + magic byte di storage sebelum dipakai.
 */
export class AttachShowcaseImagesDto {
  @ApiProperty({ type: [String], description: 'Object key gambar yang sudah dikonfirmasi.' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SHOWCASE_MAX_IMAGES_ABSOLUTE)
  @ArrayUnique()
  @IsString({ each: true })
  fileKeys!: string[];

  /**
   * PERF-FIX (NP-001): peta fileKey gambar → thumbnailFileKey. Thumbnail
   * adalah confirmed upload SHOWCASE_IMAGE milik user yang sama (auto-generate
   * sharp ~640px saat upload). Opsional & aditif — klien lama tidak
   * mengirim; gambar tanpa entri tetap valid (feed fallback ke imageUrl
   * penuh).
   */
  @ApiPropertyOptional({
    description: 'Peta fileKey gambar → thumbnailFileKey (opsional).',
    example: {
      'uploads/showcase-images/u1/1700000000000-a1b2c3d4e5-foto.jpg':
        'uploads/showcase-images/u1/1700000000001-thumb-f6g7h8i9j0.jpg',
    },
  })
  @IsOptional()
  @IsObject()
  @IsString({ each: true })
  thumbnails?: Record<string, string>;
}

export class ReorderShowcaseImagesDto {
  @ApiProperty({
    type: [String],
    description:
      'Seluruh ID gambar milik item ini, dalam urutan yang diinginkan. ' +
      'Harus lengkap — urutan disimpan ulang sebagai sortOrder 0..n-1.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SHOWCASE_MAX_IMAGES_ABSOLUTE)
  @ArrayUnique()
  @IsString({ each: true })
  imageIds!: string[];
}
