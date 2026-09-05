import { IsString, IsOptional, IsArray, IsUrl, MinLength, MaxLength, ArrayMaxSize, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SubmitDeliveryProofDto {
  @ApiProperty({ description: 'Description of the delivery proof', minLength: 10, maxLength: 2000 })
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  description!: string;

  @ApiPropertyOptional({ description: 'S3 object keys for proof files', type: [String], maxItems: 10 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  @Matches(/^uploads\/delivery-proof\//, { each: true, message: 'Each fileUrl must be a valid delivery proof upload key' })
  fileUrls?: string[];

  @ApiPropertyOptional({ description: 'Link URLs for proof', type: [String], maxItems: 5 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsUrl({ protocols: ['http', 'https'] }, { each: true, message: 'Each linkUrl must be a valid HTTP(S) URL' })
  @MaxLength(1000, { each: true })
  linkUrls?: string[];
}

export class ConfirmDeliveryDto {
  @ApiPropertyOptional({ description: 'Specific submitted delivery proof to review' })
  @IsOptional()
  @IsString()
  @Matches(/^c[a-z0-9]{24}$/, { message: 'proofId must be a valid delivery proof ID' })
  proofId?: string;
}

export class RejectDeliveryDto {
  @ApiProperty({ description: 'Reason for rejecting delivery', minLength: 10, maxLength: 1000 })
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  note!: string;

  @ApiPropertyOptional({ description: 'Specific submitted delivery proof to reject' })
  @IsOptional()
  @IsString()
  @Matches(/^c[a-z0-9]{24}$/, { message: 'proofId must be a valid delivery proof ID' })
  proofId?: string;
}
