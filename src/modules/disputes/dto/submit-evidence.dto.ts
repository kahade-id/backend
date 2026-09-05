import { IsString, IsArray, IsNotEmpty, IsIn, ArrayMinSize, ArrayMaxSize, MaxLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export const ALLOWED_EVIDENCE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;

export class SubmitEvidenceDto {
  @ApiProperty({ description: 'Evidence description', maxLength: 2000 })
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'Description must contain at least one non-whitespace character' })
  @MaxLength(2000)
  description!: string;

  @ApiProperty({ description: 'Evidence file URLs', type: [String], minItems: 1, maxItems: 10 })
  @IsArray()
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  fileUrls!: string[];

  @ApiProperty({
    description: 'File types (MIME)',
    type: [String],
    enum: ALLOWED_EVIDENCE_MIME_TYPES,
    minItems: 1,
    maxItems: 10,
  })
  @IsArray()
  @IsIn(ALLOWED_EVIDENCE_MIME_TYPES, { each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  fileTypes!: string[];
}
