import { IsString, IsOptional, MinLength, MaxLength } from 'class-validator';
import { IsValidId } from '../../../common/decorators/is-valid-id.decorator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AskQuestionDto {
  @ApiProperty({ description: 'Question content', minLength: 5, maxLength: 500 })
  @IsString()
  @MinLength(5, { message: 'Question must be at least 5 characters' })
  @MaxLength(500)
  question!: string;
}

export class AnswerQuestionDto {
  @ApiProperty({ description: 'Answer content', minLength: 1, maxLength: 2000 })
  @IsString()
  @MinLength(1, { message: 'Answer is required' })
  @MaxLength(2000)
  answer!: string;
}

export class AddCommentDto {
  @ApiProperty({ description: 'Comment content', minLength: 1, maxLength: 1000 })
  @IsString()
  @MinLength(1, { message: 'Comment is required' })
  @MaxLength(1000)
  content!: string;

  @ApiPropertyOptional({ description: 'Parent comment ID for threaded replies' })
  @IsOptional()
  @IsValidId()
  parentId?: string;
}
