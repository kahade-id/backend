import { IsBoolean, IsOptional, IsString, MinLength, MaxLength, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;
const toBoolean = ({ value }: { value: unknown }) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return value;
};

/**
 * Hapus kampanye (G356-G357).
 * - Tanpa voucher terbit: boleh dihapus selama status bukan ACTIVE.
 * - Dengan voucher terbit (count > 0): HANYA boleh bila status DRAFT + force=true + reason wajib.
 */
export class DeleteCampaignDto {
  @ApiPropertyOptional({ description: 'Paksa hapus — hanya untuk kampanye DRAFT yang sudah menerbitkan voucher', default: false })
  @IsOptional() @IsBoolean() @Transform(toBoolean)
  force?: boolean;

  @ApiPropertyOptional({ description: 'Alasan penghapusan paksa (wajib bila force=true, min 5 karakter)', minLength: 5, maxLength: 1000 })
  @IsOptional() @IsString() @MinLength(5, { message: 'reason wajib diisi bila force=true (min 5 karakter)' }) @MaxLength(1000) @Matches(/\S/, { message: 'reason cannot be blank' }) @Transform(trim)
  reason?: string;
}
