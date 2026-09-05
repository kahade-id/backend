import { IsString, IsNotEmpty, MaxLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RatingActionDto {
  @ApiProperty({ description: 'Reason for hiding or unhiding the rating', maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @Matches(/\S/, { message: 'Reason must contain non-whitespace characters' })
  reason!: string;
}
