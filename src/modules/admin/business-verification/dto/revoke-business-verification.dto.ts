import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RevokeBusinessVerificationDto {
  @ApiProperty({ description: 'Alasan pencabutan verifikasi badan usaha', minLength: 10, maxLength: 500 })
  @IsString()
  @MinLength(10)
  @Matches(/\S/, { message: 'Reason must contain at least one non-whitespace character' })
  @MaxLength(500)
  reason!: string;
}
