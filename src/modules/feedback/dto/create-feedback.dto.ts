import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
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
}
