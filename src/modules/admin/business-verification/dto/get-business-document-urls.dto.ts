import { IsNotEmpty, IsString, Matches, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class GetBusinessDocumentUrlsDto {
  @ApiProperty({
    description:
      'Password admin untuk re-authentication (wajib untuk mengakses dokumen legalitas terenkripsi)',
    minLength: 1,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @Matches(/\S/, { message: 'Password must contain at least one non-whitespace character' })
  password!: string;
}
