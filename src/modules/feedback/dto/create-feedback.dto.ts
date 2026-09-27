import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateFeedbackDto {
  @ApiProperty({ description: 'Kategori feedback', example: 'Saran fitur' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @Matches(/\S/, { message: 'category cannot be blank' })
  category!: string;

  @ApiProperty({ description: 'Isi feedback' })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(5000)
  @Matches(/\S/, { message: 'message cannot be blank' })
  message!: string;

  @ApiPropertyOptional({ description: 'Email/kontak opsional bila pengguna ingin dihubungi' })
  @IsOptional()
  @IsString()
  @MaxLength(320)
  contact?: string;

  @ApiPropertyOptional({ description: 'Rating 1-5 (opsional)', minimum: 1, maximum: 5 })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' && value !== '' ? Number(value) : value))
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @ApiPropertyOptional({ description: 'Platform pengirim', default: 'app' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  platform?: string;

  @ApiPropertyOptional({
    description: 'Persetujuan pengirim untuk dihubungi admin (wajib true agar admin boleh menghubungi)',
    default: false,
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const v = value.toLowerCase();
      if (v === 'true' || v === '1') return true;
      if (v === 'false' || v === '0') return false;
    }
    return value;
  })
  @IsBoolean()
  contactConsent?: boolean;

  @ApiPropertyOptional({ description: 'Versi aplikasi pengirim', maxLength: 32 })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  appVersion?: string;
}
