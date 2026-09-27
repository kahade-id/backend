import { IsOptional, IsString, MinLength, MaxLength, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;

/** Duplikat kampanye ke draf baru tanpa hasil redemption (G362). */
export class DuplicateCampaignDto {
  @ApiPropertyOptional({ description: 'Nama kampanye salinan (default: "<nama> (salinan)")', minLength: 3, maxLength: 100 })
  @IsOptional() @IsString() @MinLength(3) @MaxLength(100) @Matches(/\S/, { message: 'name cannot be blank' }) @Transform(trim)
  name?: string;
}
