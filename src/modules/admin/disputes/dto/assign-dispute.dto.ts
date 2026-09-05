import { IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsValidId } from '../../../../common/decorators/is-valid-id.decorator';

export class AssignDisputeDto {
  @ApiPropertyOptional({ description: 'Admin ID to assign. SUPER_ADMIN only. Defaults to self-assignment.' })
  @IsOptional()
  @IsValidId()
  adminId?: string;
}
