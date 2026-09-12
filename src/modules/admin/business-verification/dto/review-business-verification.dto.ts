import { IsOptional, IsString, MaxLength, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ReviewBusinessVerificationDto {
  @ApiPropertyOptional({ description: 'Catatan review internal', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @Matches(/\S/, { message: 'Notes must contain at least one non-whitespace character' })
  @MaxLength(1000)
  notes?: string;
}
