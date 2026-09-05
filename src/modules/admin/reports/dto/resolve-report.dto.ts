import { IsString, MinLength, MaxLength, IsOptional, IsIn, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ResolveReportDto {
  @ApiProperty({ description: 'Resolution description', minLength: 5, maxLength: 2000 })
  @IsString()
  @MinLength(5)
  @Matches(/\S/)
  @MaxLength(2000)
  resolution!: string;

  @ApiPropertyOptional({ enum: ['RESOLVED_ACTION_TAKEN', 'RESOLVED_NO_ACTION'], description: 'Resolution status' })
  @IsOptional()
  @IsIn(['RESOLVED_ACTION_TAKEN', 'RESOLVED_NO_ACTION'])
  resolveStatus?: 'RESOLVED_ACTION_TAKEN' | 'RESOLVED_NO_ACTION';
}
