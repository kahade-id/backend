import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { JobApplicationStatus } from '@prisma/client';

export class UpdateApplicationStatusDto {
  @ApiProperty({ enum: JobApplicationStatus, example: 'DIREVIEW' })
  @IsEnum(JobApplicationStatus, { message: 'Status tidak valid' })
  status!: JobApplicationStatus;

  @ApiPropertyOptional({
    description:
      'Catatan perubahan status (masuk audit trail). WAJIB diisi bila membuka ulang lamaran terminal (DITERIMA/DITOLAK → DIREVIEW).',
  })
  @IsOptional()
  @IsString({ message: 'Catatan harus berupa teks' })
  @MaxLength(2000, { message: 'Catatan maksimal 2000 karakter' })
  note?: string;

  @ApiPropertyOptional({
    description: 'Catatan internal admin (tidak tampil ke pelamar)',
  })
  @IsOptional()
  @IsString({ message: 'Catatan internal harus berupa teks' })
  @MaxLength(2000, { message: 'Catatan internal maksimal 2000 karakter' })
  internalNote?: string;
}
