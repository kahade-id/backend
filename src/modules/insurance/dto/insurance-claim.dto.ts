import { IsInt, IsOptional, IsString, MaxLength, Min, Matches } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Benefit 3 Kahade+ — pengajuan klaim asuransi.
 * amount dalam IDR (bilangan bulat, akan dikonversi ke sen).
 */
export class CreateInsuranceClaimDto {
  @ApiPropertyOptional({ description: 'ID order terkait (opsional)' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  orderId?: string;

  @ApiProperty({ description: 'Jenis klaim, mis. ORDER_PROTECTION', maxLength: 60 })
  @IsString()
  @MaxLength(60)
  @Matches(/\S/, { message: 'claimType tidak boleh kosong' })
  claimType!: string;

  @ApiProperty({ description: 'Nominal klaim dalam IDR (bilangan bulat)' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount!: number;
}
