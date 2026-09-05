import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

export class WebhookDeadLetterResolutionDto {
  @ApiProperty({ description: 'Reason or resolution note for the dead-letter event', maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @MaxLength(500)
  resolution!: string;
}
