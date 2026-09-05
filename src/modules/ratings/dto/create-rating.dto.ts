import { IsInt, Min, Max, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsValidId } from '../../../common/decorators/is-valid-id.decorator';

export class CreateRatingDto {
  @ApiProperty({ description: 'Order ID to rate' })
  @IsValidId()
  orderId!: string;

  @ApiProperty({ description: 'Star rating', minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  stars!: number;

  @ApiPropertyOptional({ description: 'Rating comment', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}
