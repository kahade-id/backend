import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { SHOWCASE_MAX_IMAGES } from '../../../common/constants/app.constants';

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
  @ArrayMaxSize(SHOWCASE_MAX_IMAGES)
  @ArrayUnique()
  @IsString({ each: true })
  fileKeys!: string[];
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
  @ArrayMaxSize(SHOWCASE_MAX_IMAGES)
  @ArrayUnique()
  @IsString({ each: true })
  imageIds!: string[];
}
