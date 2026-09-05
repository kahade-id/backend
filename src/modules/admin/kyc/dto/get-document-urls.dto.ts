import { IsString, IsNotEmpty, MinLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class GetDocumentUrlsDto {
  @ApiProperty({
    description: 'Admin password for re-authentication (required to access encrypted KYC documents)',
    minLength: 1,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @Matches(/\S/, { message: 'Password must contain at least one non-whitespace character' })
  password!: string;
}
