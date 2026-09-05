import { IsOptional, IsString, MinLength, MaxLength, Matches } from 'class-validator';

export class TrustDeviceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  @Matches(/^\d{6}$/, { message: 'mfaCode must contain exactly 6 digits' })
  mfaCode?: string;
}
