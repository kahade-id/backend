import { IsString, Length, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class Enable2faDto {
  @ApiProperty({ description: 'TOTP code from authenticator app', minLength: 6, maxLength: 6 })
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'code must contain exactly 6 digits' })
  code!: string;
}
