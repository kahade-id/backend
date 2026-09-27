import { IsString, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { PasskeyReauthDto } from '../../auth/dto/passkey.dto';

/**
 * GAP-A (G040): update nama pemilik rekening + bukti re-auth opsional.
 * Bila user punya passkey aktif dan kebijakan 'bank_account_change' aktif,
 * salah satu bukti re-auth wajib diisi (divalidasi di service).
 */
export class UpdateBankAccountDto extends PasskeyReauthDto {
  @ApiProperty({ description: 'Account holder name', minLength: 2, maxLength: 100 })
  @IsString()
  @Length(2, 100)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  accountName!: string;
}
