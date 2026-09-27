import { IsString, MinLength, MaxLength, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;

/** Alasan wajib untuk menjeda kampanye (G359). Dicatat di CampaignVersion + audit PAUSE_REASON_RECORDED. */
export class PauseCampaignDto {
  @ApiProperty({ description: 'Alasan menjeda kampanye (wajib, min 5 karakter)', minLength: 5, maxLength: 1000, example: 'Anggaran promo bulan ini habis' })
  @IsString() @MinLength(5, { message: 'reason wajib diisi (min 5 karakter)' }) @MaxLength(1000) @Matches(/\S/, { message: 'reason cannot be blank' }) @Transform(trim)
  reason!: string;
}

/** Alasan wajib untuk mengaktifkan kampanye (G359). Dicatat di CampaignVersion + audit PAUSE_REASON_RECORDED. */
export class ActivateCampaignDto {
  @ApiProperty({ description: 'Alasan mengaktifkan kampanye (wajib, min 5 karakter)', minLength: 5, maxLength: 1000, example: 'Mulai promo akhir tahun sesuai jadwal' })
  @IsString() @MinLength(5, { message: 'reason wajib diisi (min 5 karakter)' }) @MaxLength(1000) @Matches(/\S/, { message: 'reason cannot be blank' }) @Transform(trim)
  reason!: string;
}
