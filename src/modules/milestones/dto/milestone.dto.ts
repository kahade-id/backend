import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class CreateMilestoneItemDto {
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  /** Nilai tahap dalam rupiah (bilangan bulat positif). */
  @IsInt()
  @Min(1)
  amountIdr!: number;

  @IsOptional()
  @IsDateString()
  deadline?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  maxRevisionRounds?: number;
}

export class CreateMilestonesDto {
  @IsArray()
  @ArrayMinSize(2, { message: 'Order milestone membutuhkan minimal 2 tahap.' })
  @ArrayMaxSize(20, { message: 'Maksimal 20 tahap per order.' })
  @ValidateNested({ each: true })
  @Type(() => CreateMilestoneItemDto)
  milestones!: CreateMilestoneItemDto[];
}

export class UpdateMilestoneDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsDateString()
  deadline?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  maxRevisionRounds?: number;
}

export class ChangeRequestDto {
  @IsObject()
  @IsNotEmpty()
  change!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ExtendDeadlineDto {
  @IsDateString()
  newDeadline!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class EvidenceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  fileKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  fileType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  caption?: string;
}

export class RevisionDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/**
 * BFI-006 (audit integrasi): FE mengirim `{ note? }` saat submit —
 * sebelumnya body diabaikan total (tanpa @Body()). Aditif: note opsional,
 * dicatat di payload event SUBMITTED.
 */
export class SubmitMilestoneDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000, { message: 'Catatan maksimal 2000 karakter.' })
  note?: string;
}
