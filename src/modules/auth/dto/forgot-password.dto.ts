import { IsEmail, IsOptional, IsNumber, IsUUID, MaxLength, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export class ForgotPasswordDto {
  @ApiProperty({ description: 'Email address', maxLength: 254 })
  @IsEmail()
  @MaxLength(254)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase().trim() : value))
  email!: string;

  @ApiPropertyOptional({ description: 'Captcha challenge ID' })
  @IsOptional()
  @IsUUID()
  captchaId?: string;

  @ApiPropertyOptional({ description: 'Captcha answer (X position 0-100)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  captchaAnswer?: number;
}
