import { IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class VerifyPasswordDto {
  @ApiProperty({ description: 'Password to verify' })
  @IsString()
  @MinLength(1)
  @MaxLength(72)
  password!: string;
}
