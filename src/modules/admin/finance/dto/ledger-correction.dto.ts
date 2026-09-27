import { IsOptional, IsString, IsNotEmpty, IsNumber, Min, MaxLength, MinLength, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../../../common/dto/pagination.dto';

export const CORRECTION_TYPES = ['CREDIT', 'DEBIT'] as const;
export type CorrectionType = (typeof CORRECTION_TYPES)[number];

export const CORRECTION_DECISIONS = ['APPROVE', 'REJECT'] as const;
export type CorrectionDecision = (typeof CORRECTION_DECISIONS)[number];

export class RequestCorrectionDto {
  @ApiProperty({ description: 'User ID (cuid) pemilik wallet yang dikoreksi' })
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

  @ApiPropertyOptional({
    description:
      'FOLLOW-UP (belum diverifikasi server-side): token re-autentikasi admin. ' +
      'UI wajib meminta kata sandi admin sebelum submit; verifikasi server-side ' +
      'terhadap hash kata sandi admin belum tersedia dan dicatat sebagai tindak lanjut.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reauthToken?: string;
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

  @ApiPropertyOptional({ description: 'FOLLOW-UP: token re-autentikasi admin (lihat RequestCorrectionDto)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reauthToken?: string;
}

export class CorrectionsQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: ['PENDING_APPROVAL', 'APPROVED', 'REJECTED'], description: 'Filter by lifecycle status' })
  @IsOptional()
  @IsIn(['PENDING_APPROVAL', 'APPROVED', 'REJECTED'])
  status?: 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';
}
