import { IsString, IsNotEmpty, MinLength, MaxLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SubmitClaimDto {
  @ApiProperty({ description: 'Dispute claim description', minLength: 20, maxLength: 5000 })
  @IsString()
  @IsNotEmpty()
  @MinLength(20)
  @Matches(/\S/, { message: 'Claim must contain at least one non-whitespace character' })
  @MaxLength(5000)
  claim!: string;
}
