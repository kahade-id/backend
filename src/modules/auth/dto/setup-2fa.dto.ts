import { IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class Setup2faDto {
  @ApiProperty({ description: 'Current password for verification', maxLength: 72 })
  @IsString()
  @IsNotEmpty({ message: 'Password is required' })
  @MaxLength(72)
  password!: string;
}
