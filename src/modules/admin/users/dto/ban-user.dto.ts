import { IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class BanUserDto {
  @ApiProperty({ description: 'Reason for banning the user', minLength: 5, maxLength: 500 })
  @IsString()
  @MinLength(5, { message: 'Reason must be at least 5 characters' })
  @MaxLength(500, { message: 'Reason must be at most 500 characters' })
  reason!: string;
}
