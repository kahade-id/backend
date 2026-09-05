import { IsInt, IsBoolean, IsOptional, Min, Max } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsValidId } from '../../../common/decorators/is-valid-id.decorator';

export class UpdateScheduleDto {
  @ApiPropertyOptional({ description: 'Day of week (0=Sunday, 6=Saturday)', minimum: 0, maximum: 6 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek?: number;

  @ApiPropertyOptional({ description: 'Minimum balance to trigger withdrawal', minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  minAmount?: number;

  @ApiPropertyOptional({ description: 'Whether the schedule is active' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ description: 'Bank account ID to withdraw to' })
  @IsOptional()
  @IsValidId()
  bankAccountId?: string;
}
