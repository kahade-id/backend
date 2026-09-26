import { IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class GrayRevokeDto {
  @ApiProperty({
    description: 'Alasan pencabutan tier abu (FULLY_VERIFIED) oleh admin',
    minLength: 10,
    maxLength: 500,
  })
  @IsString()
  @MinLength(10, { message: 'Reason must be at least 10 characters' })
  @MaxLength(500, { message: 'Reason must be at most 500 characters' })
  reason!: string;
}
