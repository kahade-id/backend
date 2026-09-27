import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AddressLabel } from '@prisma/client';

/**
 * BE-COMMERCE (2026-10-01): buku alamat user.
 * Label RUMAH/KANTOR/LAINNYA (custom = teks bebas bila LAINNYA).
 */
export class CreateAddressDto {
  @ApiProperty({ enum: AddressLabel, default: AddressLabel.RUMAH })
  @IsEnum(AddressLabel)
  label!: AddressLabel;

  @ApiPropertyOptional({ description: 'Label custom bila label=LAINNYA', maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  customLabel?: string;

  @ApiProperty({ maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  recipientName!: string;

  @ApiProperty({ description: 'Nomor HP penerima', maxLength: 20 })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[0-9+][0-9 ]{7,19}$/, { message: 'Nomor HP tidak valid' })
  phone!: string;

  @ApiProperty({ maxLength: 300 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  addressLine!: string;

  @ApiProperty({ maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  city!: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  province?: string;

  @ApiProperty({ maxLength: 10 })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[0-9]{5}$/, { message: 'Kode pos harus 5 digit angka' })
  postalCode!: string;
}

export class UpdateAddressDto {
  @ApiPropertyOptional({ enum: AddressLabel })
  @IsOptional()
  @IsEnum(AddressLabel)
  label?: AddressLabel;

  @ApiPropertyOptional({ maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  customLabel?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  recipientName?: string;

  @ApiPropertyOptional({ maxLength: 20 })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9+][0-9 ]{7,19}$/, { message: 'Nomor HP tidak valid' })
  phone?: string;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  addressLine?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  city?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  province?: string;

  @ApiPropertyOptional({ maxLength: 10 })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9]{5}$/, { message: 'Kode pos harus 5 digit angka' })
  postalCode?: string;
}
