import { IsString, IsOptional, MinLength, MaxLength, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RequestDocumentsDto {
  @ApiProperty({
    description: 'Pesan untuk pengguna: dokumen tambahan apa yang diminta — wajib, min 10 karakter',
    minLength: 10,
    maxLength: 1000,
  })
  @IsString()
  @MinLength(10)
  @Matches(/\S/, { message: 'message must contain at least one non-whitespace character' })
  @MaxLength(1000)
  message!: string;

  @ApiPropertyOptional({ description: 'Catatan internal reviewer (opsional)', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @Matches(/\S/, { message: 'notes must contain at least one non-whitespace character' })
  @MaxLength(1000)
  notes?: string;
}
