import { IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateOpsSettingDto {
  @ApiProperty({ description: 'Nilai baru setting (maks 500 karakter)', example: 'true' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  value!: string;

  @ApiPropertyOptional({
    description:
      'BAI-118: optimistic locking — versi yang ditampilkan saat admin memuat halaman. ' +
      'Bila versi DB sudah berubah, request ditolak 409.',
    example: 3,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}

export class TestOpsSettingDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  candidateValue?: string;
}
