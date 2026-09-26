import { IsInt, IsOptional, IsString, MaxLength, Min, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * POST /v1/admin/subscriptions/grant — buat subscription ACTIVE manual.
 */
export class GrantSubscriptionDto {
  @ApiProperty({ description: 'ID user penerima subscription' })
  @IsString()
  @MaxLength(64)
  userId!: string;

  @ApiProperty({ enum: ['MONTHLY', 'YEARLY'], description: 'Plan subscription' })
  @IsString()
  @Matches(/^(MONTHLY|YEARLY)$/, { message: 'plan harus MONTHLY atau YEARLY' })
  plan!: 'MONTHLY' | 'YEARLY';

  @ApiProperty({ description: 'Durasi subscription dalam hari' })
  @IsInt()
  @Min(1)
  durationDays!: number;

  @ApiPropertyOptional({ description: 'Alasan pemberian manual (audit)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class CancelSubscriptionDto {
  @ApiPropertyOptional({ description: 'Alasan pembatalan (audit)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
