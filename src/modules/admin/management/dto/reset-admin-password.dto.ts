import { IsOptional, IsString, MinLength, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * AUT-002: body untuk POST /v1/admin/management/:id/reset-password.
 * Password sementara opsional — bila tidak diberikan, backend membangkitkan
 * yang memenuhi kebijakan admin (min 12 + kompleksitas). Bila diberikan,
 * WAJIB memenuhi kebijakan yang sama (divalidasi server-side).
 */
export class ResetAdminPasswordDto {
  @ApiPropertyOptional({
    description: 'Password sementara (opsional; dibangkitkan bila kosong). Min 12 + kompleksitas.',
    minLength: 12,
    maxLength: 72,
  })
  @IsOptional()
  @IsString()
  @MinLength(12)
  @MaxLength(72)
  temporaryPassword?: string;
}
