import { IsOptional, IsEnum, IsISO8601, IsNotEmpty } from 'class-validator';
import { WalletTransactionType, WalletTransactionStatus } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../../../common/dto/pagination.dto';

export class FinanceTransactionQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: WalletTransactionType, description: 'Filter by transaction type' })
  @IsOptional()
  @IsEnum(WalletTransactionType)
  type?: WalletTransactionType;

  @ApiPropertyOptional({ enum: WalletTransactionStatus, description: 'Filter by transaction status' })
  @IsOptional()
  @IsEnum(WalletTransactionStatus)
  status?: WalletTransactionStatus;

  // startDate and endDate are mandatory — the service throws if absent,
  // so the DTO must enforce them at the validation layer instead of letting
  // requests reach the service with missing params.
  @ApiProperty({ description: 'Start date in ISO 8601 format (required)' })
  @IsNotEmpty()
  @IsISO8601()
  startDate!: string;

  @ApiProperty({ description: 'End date in ISO 8601 format (required)' })
  @IsNotEmpty()
  @IsISO8601()
  endDate!: string;
}
