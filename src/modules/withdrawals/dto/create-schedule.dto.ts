import { IsInt, IsOptional, IsString, IsNotEmpty, Length, Matches, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsValidId } from '../../../common/decorators/is-valid-id.decorator';

export class CreateScheduleDto {
  @ApiProperty({ description: 'Bank account ID to withdraw to' })
  @IsValidId()
  bankAccountId!: string;

  @ApiProperty({ description: 'Day of week (0=Sunday, 6=Saturday)', minimum: 0, maximum: 6 })
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @ApiPropertyOptional({ description: 'Minimum balance to trigger withdrawal', minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  minAmount?: number;

  @ApiProperty({ description: '6-digit wallet PIN — authorizes creation of an automated withdrawal schedule', minLength: 6, maxLength: 6 })
  @IsString()
  @IsNotEmpty()
  @Length(6, 6, { message: 'Wallet PIN must be exactly 6 digits' })
  @Matches(/^\d{6}$/, { message: 'Wallet PIN must consist of 6 numeric digits' })
  pin!: string;
}
