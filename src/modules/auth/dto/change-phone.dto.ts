import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class RequestPhoneChangeDto {
  @IsString()
  @MaxLength(20)
  newPhoneNumber!: string;

  @IsIn(['SMS', 'WHATSAPP'])
  method!: 'SMS' | 'WHATSAPP';

  @IsString()
  @MinLength(1)
  @MaxLength(256)
  currentPassword!: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  @Matches(/^(?:\d{6}|[A-Za-z0-9]{10,16})$/, {
    message: 'mfaCode must be a six-digit authenticator code or a 10–16 character backup code',
  })
  mfaCode?: string;
}

export class ConfirmPhoneChangeDto {
  @IsString()
  @MaxLength(20)
  newPhoneNumber!: string;

  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}
