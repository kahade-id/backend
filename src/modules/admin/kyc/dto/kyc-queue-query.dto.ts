import { IsOptional, IsString, IsIn } from 'class-validator';
import { PaginationDto } from '../../../../common/dto/pagination.dto';

export class KycQueueQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  @IsIn(['PENDING', 'APPROVED', 'REJECTED', 'REVOKED'])
  status?: string;
}
