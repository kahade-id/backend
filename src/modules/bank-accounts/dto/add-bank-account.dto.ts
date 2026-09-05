import { IsString, IsEnum, Length, Matches, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { BankCode } from '@prisma/client';
import { Transform } from 'class-transformer';

export class AddBankAccountDto {
  @ApiProperty({ enum: BankCode, description: 'Bank code (must match BankCode enum)' })
  @IsEnum(BankCode, { message: 'Invalid bank code. Use a code available at /public/banks.' })
  bankCode!: BankCode;

  @ApiProperty({ description: 'Bank name', minLength: 2, maxLength: 100 })
  @IsString()
  @MinLength(2, { message: 'Bank name must be at least 2 characters' })
  @MaxLength(100, { message: 'Bank name must be at most 100 characters' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  bankName!: string;

  @ApiProperty({ description: 'Account number (6-20 digits)', pattern: '^\\d{6,20}$' })
  @IsString()
  @Matches(/^\d{6,20}$/, { message: 'Account number must be 6-20 digits' })
  accountNumber!: string;

  @ApiProperty({ description: 'Account holder name', minLength: 2, maxLength: 100 })
  @IsString()
  @Length(2, 100, { message: 'Account holder name must be 2-100 characters' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  accountName!: string;
}
