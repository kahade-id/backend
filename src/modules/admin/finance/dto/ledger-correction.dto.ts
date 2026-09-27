import { IsOptional, IsString, IsNotEmpty, IsNumber, Min, MaxLength, MinLength, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../../../common/dto/pagination.dto';

export const CORRECTION_TYPES = ['CREDIT', 'DEBIT'] as const;
export type CorrectionType = (typeof CORRECTION_TYPES)[number];

export const CORRECTION_DECISIONS = ['APPROVE', 'REJECT'] as const;
export type CorrectionDecision = (typeof CORRECTION_DECISIONS)[number];

export class RequestCorrectionDto {
  @ApiProperty({ description: 'ID user pemilik wallet — boleh ID publik (USR-XXXXXXXX) atau cuid internal; diresolusi server-side' })
  @IsString()
  @IsNotEmpty()
  userId!: string;

  @ApiProperty({ description: 'Nominal koreksi dalam Rupiah (bilangan bulat, > 0)' })
  @IsNumber()
  @Min(1)
  amountIdr!: number;

  @ApiProperty({ enum: CORRECTION_TYPES, description: 'CREDIT menambah saldo, DEBIT mengurangi saldo' })
  @IsIn(CORRECTION_TYPES)
  type!: CorrectionType;

  @ApiProperty({ description: 'Alasan koreksi — WAJIB (min 10 karakter)' })
  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;

  @ApiProperty({ description: 'Referensi tiket/insiden — WAJIB' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  ticketRef!: string;

  @ApiProperty({ description: 'Kunci idempotency domain (UUID) — replay dengan payload sama mengembalikan request yang sama' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  idempotencyKey!: string;

  @ApiProperty({
    description:
      'ADM-206: kata sandi admin saat ini untuk re-autentikasi. Diverifikasi ' +
      'server-side terhadap hash bcrypt AdminUser (rate limit 5x salah / 15 mnt). ' +
      'WAJIB diisi — menggantikan token palsu "password-confirm:provided". ' +
      'Tidak pernah di-log.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  reauthPassword!: string;
}

export class DecideCorrectionDto {
  @ApiProperty({ enum: CORRECTION_DECISIONS, description: 'APPROVE mengeksekusi mutasi, REJECT membatalkan request' })
  @IsIn(CORRECTION_DECISIONS)
  decision!: CorrectionDecision;

  @ApiPropertyOptional({ description: 'Catatan keputusan (maks 2000 karakter)' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiProperty({
    description:
      'ADM-206: kata sandi admin saat ini untuk re-autentikasi (sama seperti RequestCorrectionDto). ' +
      'WAJIB — keputusan APPROVE mengeksekusi mutasi saldo.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  reauthPassword!: string;
}

export class CorrectionsQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: ['PENDING_APPROVAL', 'APPROVED', 'REJECTED'], description: 'Filter by lifecycle status' })
  @IsOptional()
  @IsIn(['PENDING_APPROVAL', 'APPROVED', 'REJECTED'])
  status?: 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';
}
