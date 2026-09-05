import { IsString, IsOptional, IsNumber, IsEnum, IsInt, IsBoolean, Min, Max, MinLength, MaxLength } from 'class-validator';
import {
  ORDER_MIN_VALUE,
  ORDER_MAX_VALUE,
  DELIVERY_DEADLINE_DAYS_MIN,
  DELIVERY_DEADLINE_DAYS_MAX,
} from '../../../common/constants/app.constants';

export class CreateTemplateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsEnum(['PHYSICAL_GOODS', 'DIGITAL_GOODS', 'SERVICE', 'OTHER'])
  orderType!: 'PHYSICAL_GOODS' | 'DIGITAL_GOODS' | 'SERVICE' | 'OTHER';

  @IsNumber()
  @Min(ORDER_MIN_VALUE)
  @Max(ORDER_MAX_VALUE)
  orderValue!: number;

  @IsOptional()
  @IsEnum(['BUYER', 'SELLER', 'SPLIT'])
  feeResponsibility?: 'BUYER' | 'SELLER' | 'SPLIT';

  @IsOptional()
  @IsInt()
  @Min(DELIVERY_DEADLINE_DAYS_MIN)
  @Max(DELIVERY_DEADLINE_DAYS_MAX)
  deliveryDeadlineDays?: number;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateTemplateDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsEnum(['PHYSICAL_GOODS', 'DIGITAL_GOODS', 'SERVICE', 'OTHER'])
  orderType?: 'PHYSICAL_GOODS' | 'DIGITAL_GOODS' | 'SERVICE' | 'OTHER';

  @IsOptional()
  @IsNumber()
  @Min(ORDER_MIN_VALUE)
  @Max(ORDER_MAX_VALUE)
  orderValue?: number;

  @IsOptional()
  @IsEnum(['BUYER', 'SELLER', 'SPLIT'])
  feeResponsibility?: 'BUYER' | 'SELLER' | 'SPLIT';

  @IsOptional()
  @IsInt()
  @Min(DELIVERY_DEADLINE_DAYS_MIN)
  @Max(DELIVERY_DEADLINE_DAYS_MAX)
  deliveryDeadlineDays?: number;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
