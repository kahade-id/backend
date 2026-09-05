import { IsString, MinLength, MaxLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SendDisputeMessageDto {
  @ApiProperty({ description: 'Message content to send into the dispute order chat', minLength: 1, maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  @Matches(/\S/, { message: 'content must contain non-whitespace characters' })
  content!: string;
}
