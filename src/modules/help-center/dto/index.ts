import { IsString, IsOptional, IsInt, IsBoolean, Min, MaxLength } from 'class-validator';

export class CreateFaqCategoryDto {
  @IsString()
  @MaxLength(100)
  slug!: string;

  @IsString()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  nameEn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  descriptionEn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  icon?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateFaqCategoryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  nameEn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  descriptionEn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  icon?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateFaqItemDto {
  @IsString()
  @MaxLength(100)
  categoryId!: string;

  @IsString()
  @MaxLength(500)
  question!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  questionEn?: string;

  @IsString()
  @MaxLength(10000)
  answer!: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  answerEn?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateFaqItemDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  question?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  questionEn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  answer?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  answerEn?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
