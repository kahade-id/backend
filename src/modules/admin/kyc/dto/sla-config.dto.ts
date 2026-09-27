import { IsString, IsIn, IsInt, IsBoolean, Min, Max, MinLength, MaxLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { SLA_SCOPES, type SlaScope } from '../sla.util';

export class UpdateSlaConfigDto {
  @ApiProperty({ description: 'Scope konfigurasi SLA', enum: SLA_SCOPES })
  @IsString()
  @IsIn([...SLA_SCOPES])
  scope!: SlaScope;

  @ApiProperty({ description: 'Batas SLA dalam jam (1–720)', minimum: 1, maximum: 720 })
  @IsInt()
  @Min(1)
  @Max(720)
  slaHours!: number;

  @ApiProperty({ description: 'true = hitung jam kerja (Senin–Jumat 09:00–17:00 WIB); false = jam kalender' })
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  useBusinessHours!: boolean;

  @ApiProperty({ description: 'Alasan perubahan — wajib untuk audit', minLength: 10, maxLength: 1000 })
  @IsString()
  @MinLength(10)
  @Matches(/\S/, { message: 'changeReason must contain at least one non-whitespace character' })
  @MaxLength(1000)
  changeReason!: string;
}
