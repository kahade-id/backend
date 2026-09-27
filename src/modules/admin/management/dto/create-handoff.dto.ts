import { IsString, IsOptional, IsIn, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** GAP-E (G397) — catatan handoff kasus antar petugas admin. */
export class CreateHandoffDto {
  @ApiProperty({ description: 'Jenis kasus.', enum: ['kyc', 'dispute', 'report'] })
  @IsString()
  @IsIn(['kyc', 'dispute', 'report'])
  caseType!: 'kyc' | 'dispute' | 'report';

  @ApiProperty({ description: 'ID kasus (id internal / nomor kasus publik).' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  caseId!: string;

  @ApiProperty({ description: 'ID admin pemberi (from).' })
  @IsString()
  @MaxLength(100)
  fromAdminId!: string;

  @ApiProperty({ description: 'ID admin penerima (to).' })
  @IsString()
  @MaxLength(100)
  toAdminId!: string;

  @ApiPropertyOptional({ description: 'Catatan handoff untuk penerima.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class HandoffQueryDto {
  @ApiProperty({ description: 'Jenis kasus.', enum: ['kyc', 'dispute', 'report'] })
  @IsString()
  @IsIn(['kyc', 'dispute', 'report'])
  caseType!: 'kyc' | 'dispute' | 'report';

  @ApiProperty({ description: 'ID kasus.' })
  @IsString()
  @MaxLength(100)
  caseId!: string;
}
