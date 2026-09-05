import { IsString, IsNotEmpty, IsOptional, MaxLength, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateConfigDto {
  @ApiProperty({ description: 'Configuration value', maxLength: 5000 })
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @MaxLength(5000)
  value!: string;

  @ApiPropertyOptional({ description: 'Configuration description', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
