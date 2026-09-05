import { IsOptional, IsString, IsNotEmpty, MinLength, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class WithdrawalRejectDto {
  @ApiProperty({ description: 'Reason for rejection (required)', minLength: 5, maxLength: 1000 })
  @IsString()
  @IsNotEmpty({ message: 'Rejection reason is required' })
  @MinLength(5, { message: 'Rejection reason must be at least 5 characters' })
  @MaxLength(1000)
  adminNote!: string;
}

export class WithdrawalApproveDto {
  @ApiPropertyOptional({ description: 'Approval note', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  adminNote?: string;
}
