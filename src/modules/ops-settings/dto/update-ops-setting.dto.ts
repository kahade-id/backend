import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateOpsSettingDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  value!: string;
}

export class TestOpsSettingDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  candidateValue?: string;
}
