import { IsString, IsOptional, Length, Matches, MinLength, ValidateIf } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SetPinDto {
  @ApiProperty({ description: 'New wallet PIN (6 digits)', minLength: 6, maxLength: 6 })
  @IsString()
  @Length(6, 6, { message: 'PIN must be exactly 6 digits' })
  @Matches(/^\d{6}$/, { message: 'PIN must contain only digits' })
  pin!: string;

  @ApiPropertyOptional({ description: 'Current wallet PIN — required when changing an existing PIN', minLength: 6, maxLength: 6 })
  @IsOptional()
  @IsString()
  @Length(6, 6, { message: 'Current PIN must be exactly 6 digits' })
  @Matches(/^\d{6}$/, { message: 'Current PIN must contain only digits' })
  currentPin?: string;

  // Catatan: service (setPin) SELALU mewajibkan password — baik saat
  // membuat PIN pertama maupun mengubah PIN yang sudah ada. Field ini
  // dimodelkan opsional di schema agar klien lama tidak rusak, tetapi
  // request tanpa password akan ditolak dengan 400.
  @ApiPropertyOptional({ description: 'Account password — always required by the service (first PIN and PIN change)' })
  @ValidateIf((o) => !!o.currentPin)
  @IsString()
  @MinLength(1, { message: 'Password is required when changing an existing PIN' })
  @IsOptional()
  password?: string;
}

export class VerifyPinDto {
  @ApiProperty({ description: 'Wallet PIN to verify (6 digits)', minLength: 6, maxLength: 6 })
  @IsString()
  @Length(6, 6, { message: 'PIN must be exactly 6 digits' })
  @Matches(/^\d{6}$/, { message: 'PIN must contain only digits' })
  pin!: string;
}
