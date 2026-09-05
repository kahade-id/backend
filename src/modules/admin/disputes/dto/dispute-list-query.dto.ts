import { IsOptional, IsString, IsIn, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../../../common/dto/pagination.dto';

const DISPUTE_STATUSES = ['OPEN', 'ASSIGNED', 'UNDER_REVIEW', 'WAITING_RESPONSE', 'ESCALATED', 'RESOLVED', 'CANCELLED'];

export class DisputeListQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Filter by dispute status' })
  @IsOptional()
  @IsString()
  @IsIn(DISPUTE_STATUSES)
  status?: string;

  @ApiPropertyOptional({ description: 'Search by dispute public ID (disputeId) or order public ID (orderId)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}
