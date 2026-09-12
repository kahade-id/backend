import { IsIn, IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../../../common/dto/pagination.dto';

export class BusinessVerificationQueueQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    enum: ['PENDING', 'APPROVED', 'REJECTED', 'REVOKED'],
    description: 'Filter queue by status. Default: semua status.',
  })
  @IsOptional()
  @IsString()
  @IsIn(['PENDING', 'APPROVED', 'REJECTED', 'REVOKED'])
  status?: string;
}
