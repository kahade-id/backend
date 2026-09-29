import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * Payout satu arah saldo wallet lama ke rekening bank (mode tanpa-wallet).
 * amountSen dikirim sebagai string agar presisi BigInt aman di JSON.
 */
export class LegacyPayoutDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^[1-9][0-9]*$/, { message: 'amountSen harus bilangan bulat positif (dalam sen)' })
  @MaxLength(18)
  amountSen!: string;

  @IsString()
  @IsNotEmpty()
  pin!: string;

  /** Kunci idempotency dari klien untuk retry aman (opsional). */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  idempotencyKey?: string;
}
