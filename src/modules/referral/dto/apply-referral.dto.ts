import { IsString, IsNotEmpty, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class ApplyReferralDto {
  @ApiProperty({
    description: 'Referral code (format: KH followed by 6-8 alphanumeric characters)',
    pattern: '^KH[A-Z0-9]{6,8}$',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  @IsNotEmpty()
  @Matches(/^KH[A-Z0-9]{6,8}$/, { message: 'Invalid referral code format' })
  code!: string;
}
