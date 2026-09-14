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

  // Fixed: password is conditionally required when changing an existing PIN.
  // Previously marked @IsOptional with @ApiProperty saying required — contradictory OpenAPI.
  // Now properly modeled as optional in schema but enforced in service when currentPin exists,
  // and documented accurately.
  @ApiPropertyOptional({ description: 'Account password — required when changing an existing PIN, optional when setting first PIN' })
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
