import { IsString, MinLength, MaxLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RevokeKycDto {
  @ApiProperty({ description: 'Reason for KYC revocation', minLength: 10, maxLength: 500 })
  @IsString()
  @MinLength(10)
  @Matches(/\S/, { message: 'Reason must contain at least one non-whitespace character' })
  @MaxLength(500)
  reason!: string;
}
