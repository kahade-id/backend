import { IsNotEmpty, IsString, Length, Matches, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegenerateBackupCodesDto {
  @ApiProperty({ description: 'Current account password', maxLength: 72 })
  @IsString()
  @IsNotEmpty({ message: 'Password is required' })
  @MaxLength(72)
  password!: string;

  @ApiProperty({ description: 'Six-digit authenticator TOTP code', minLength: 6, maxLength: 6 })
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'Authenticator code must contain exactly six digits' })
  code!: string;
}
