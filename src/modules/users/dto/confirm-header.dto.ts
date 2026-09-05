import { IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ConfirmHeaderDto {
  @ApiProperty({ description: 'S3 key of the uploaded header image' })
  @IsString()
  @MinLength(1, { message: 'headerKey is required' })
  headerKey!: string;
}
