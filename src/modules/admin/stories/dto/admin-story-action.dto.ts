import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class AdminStoryReasonDto {
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class HideStoryDto extends AdminStoryReasonDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  durationDays?: number;
}

export class BanStoryFeatureDto extends AdminStoryReasonDto {
  /** Omitted means permanent; otherwise 1–3650 days. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  durationDays?: number;
}

export class ReviewStoryReportDto {
  @IsIn(['in_review', 'delete', 'hide', 'ban', 'dismiss'])
  action!: 'in_review' | 'delete' | 'hide' | 'ban' | 'dismiss';

  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty()
  @MaxLength(1000)
  internalNote!: string;

  /** Used for temporary hide/feature-ban; omission for ban means permanent. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  durationDays?: number;
}
