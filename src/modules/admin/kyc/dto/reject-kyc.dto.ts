import { IsString, IsOptional, MinLength, MaxLength, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RejectKycDto {
  @ApiProperty({ description: 'Reason for rejection', minLength: 10, maxLength: 500 })
  @IsString()
  @MinLength(10)
  @Matches(/\S/, { message: 'Reason must contain at least one non-whitespace character' })
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({ description: 'Additional notes', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @Matches(/\S/, { message: 'Notes must contain at least one non-whitespace character' })
  @MaxLength(1000)
  notes?: string;
}
