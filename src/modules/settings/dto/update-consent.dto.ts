import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ConsentType } from '@prisma/client';

/** G084–G086: berikan atau tarik sebuah persetujuan. */
export class UpdateConsentDto {
  @ApiProperty({ enum: ConsentType, description: 'Jenis persetujuan' })
  @IsEnum(ConsentType)
  type!: ConsentType;

  @ApiProperty({ description: 'true = setuju, false = tarik persetujuan' })
  @IsBoolean()
  granted!: boolean;

  @ApiProperty({ description: 'Kanal pemberian (push/email/whatsapp/in-app)', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  channel?: string;
}
