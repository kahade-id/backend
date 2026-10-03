import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ArrayMaxSize,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateJobPostingDto {
  @ApiPropertyOptional({
    description: 'Slug URL; otomatis dibuat dari judul bila kosong',
    example: 'co-founder-coo',
  })
  @IsOptional()
  @IsString({ message: 'Slug harus berupa teks' })
  @Matches(/^[a-z0-9-]+$/, {
    message: 'Slug hanya boleh huruf kecil, angka, dan tanda hubung',
  })
  @MaxLength(128, { message: 'Slug maksimal 128 karakter' })
  slug?: string;

  @ApiProperty({ example: 'Co-Founder / COO' })
  @IsString({ message: 'Judul wajib diisi' })
  @MinLength(3, { message: 'Judul minimal 3 karakter' })
  @MaxLength(200, { message: 'Judul maksimal 200 karakter' })
  title!: string;

  @ApiProperty({ example: 'Remote' })
  @IsString({ message: 'Lokasi wajib diisi' })
  @MinLength(2, { message: 'Lokasi minimal 2 karakter' })
  @MaxLength(128, { message: 'Lokasi maksimal 128 karakter' })
  location!: string;

  @ApiProperty({ example: 'Penuh waktu' })
  @IsString({ message: 'Tipe pekerjaan wajib diisi' })
  @MaxLength(64, { message: 'Tipe pekerjaan maksimal 64 karakter' })
  type!: string;

  @ApiProperty({
    description: 'Skema kompensasi — WAJIB diisi dan tampil eksplisit (tanpa gaji + saham)',
    example: '15% saham (tanpa gaji, skema vesting)',
  })
  @IsString({ message: 'Skema kompensasi (equity) wajib diisi' })
  @MinLength(2, { message: 'Skema kompensasi minimal 2 karakter' })
  @MaxLength(128, { message: 'Skema kompensasi maksimal 128 karakter' })
  equity!: string;

  @ApiProperty({ description: '1-2 kalimat untuk kartu lowongan' })
  @IsString({ message: 'Ringkasan wajib diisi' })
  @MinLength(10, { message: 'Ringkasan minimal 10 karakter' })
  @MaxLength(500, { message: 'Ringkasan maksimal 500 karakter' })
  summary!: string;

  @ApiProperty({ description: 'Deskripsi lengkap (markdown): tanggung jawab, kualifikasi' })
  @IsString({ message: 'Deskripsi wajib diisi' })
  @MinLength(20, { message: 'Deskripsi minimal 20 karakter' })
  description!: string;

  @ApiProperty({ type: [String], example: ['Berpengalaman 5+ tahun', 'Bisa kerja remote'] })
  @IsOptional()
  @IsArray({ message: 'Requirements harus berupa array' })
  @IsString({ each: true, message: 'Setiap requirement harus berupa teks' })
  @ArrayMaxSize(30, { message: 'Maksimal 30 requirement' })
  requirements?: string[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean({ message: 'isActive harus boolean' })
  isActive?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt({ message: 'sortOrder harus bilangan bulat' })
  @Min(0, { message: 'sortOrder minimal 0' })
  sortOrder?: number;
}
