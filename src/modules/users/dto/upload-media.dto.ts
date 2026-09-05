import { IsString, IsOptional, IsIn } from 'class-validator';
import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export class UploadMediaDto {
  @ApiPropertyOptional({ description: 'Content type of the image', enum: ALLOWED_IMAGE_TYPES })
  @IsOptional()
  @IsString()
  @IsIn(ALLOWED_IMAGE_TYPES, { message: 'contentType must be image/jpeg, image/png, or image/webp' })
  contentType?: string;
}

export class ConfirmHeaderDto {
  @ApiProperty({ description: 'S3 key of the uploaded header image' })
  @IsString()
  headerKey!: string;
}

export class AccountDeletionDto {
  @ApiProperty({ description: 'User password for confirmation' })
  @IsString()
  password!: string;

  @ApiPropertyOptional({ description: 'Reason for account deletion' })
  @IsOptional()
  @IsString()
  reason?: string;
}

export class AskQuestionDto {
  @ApiProperty({ description: 'Question text' })
  @IsString()
  question!: string;
}

export class AnswerQuestionDto {
  @ApiProperty({ description: 'Answer text' })
  @IsString()
  answer!: string;
}
