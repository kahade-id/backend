import { IsOptional, IsString, MaxLength, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ReviewKycDto {
  @ApiPropertyOptional({ description: 'Review notes', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @Matches(/\S/, { message: 'Notes must contain at least one non-whitespace character' })
  @MaxLength(1000)
  notes?: string;
}
