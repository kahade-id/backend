import { IsEnum, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { VoucherApplicability } from '@prisma/client';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class ListVouchersDto extends PaginationDto {
  @ApiPropertyOptional({ enum: VoucherApplicability, description: 'Filter by applicable category' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsEnum(VoucherApplicability)
  applicableTo?: VoucherApplicability;
}
